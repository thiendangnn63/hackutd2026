"""Build the bounded Beacon Harvey Sentinel-2 layers. Development only.

Install rasterio==1.4.3, numpy==2.0.2 and Pillow==11.3.0 in a temporary environment.
Run with --cache-dir PATH to download the six named public granules and build images.
Run with --check for offline artifact validation. No external service is used by Beacon.
"""
import argparse
import hashlib
import json
import math
import subprocess
from pathlib import Path

import numpy as np
from PIL import Image
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject, transform_bounds
from rasterio.windows import Window, from_bounds as window_from_bounds

DATA = Path(__file__).resolve().parents[1] / 'public/data'
MANIFEST = DATA / 'houston-water-imagery.json'
CATALOG = 'https://earth-search.aws.element84.com/v1/collections/sentinel-2-l2a/items/'
BBOX = [-95.94, 29.48, -94.99, 30.14]
WIDTH, HEIGHT = 4600, 3660
GRID = from_bounds(*BBOX, WIDTH, HEIGHT)
DATES = {
    '2017-08-15': ['S2A_15RTN_20170815_0_L2A', 'S2A_15RTP_20170815_1_L2A'],
    '2017-08-30': ['S2B_15RTN_20170830_0_L2A', 'S2B_15RTP_20170830_0_L2A'],
    '2017-09-01': ['S2A_15RTN_20170901_0_L2A', 'S2A_15RTP_20170901_0_L2A'],
}
PALETTE = [(-1, [27,32,37]), (-.4, [55,60,65]), (0, [109,115,119]),
           (.12, [56,139,141]), (.35, [16,184,181]), (.65, [66,222,211]), (1, [163,251,231])]
NODATA = -32768


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as fp:
        for block in iter(lambda: fp.read(1024*1024), b''):
            h.update(block)
    return h.hexdigest()


def download(url, path):
    if path.exists():
        return
    part = path.with_suffix(path.suffix+'.part')
    subprocess.run(['curl', '--fail', '--location', '--silent', '--show-error',
                    '--retry', '2', '--max-time', '240', url, '-o', str(part)], check=True)
    part.replace(path)


def read_granule(cache, item_id):
    expected={}
    if MANIFEST.exists():
        published=json.loads(MANIFEST.read_text())
        expected={s['id']:s for date in published['scenes'] for s in date['sources']}
    item_path = cache/(item_id+'.json')
    download(CATALOG+item_id, item_path)
    f = json.loads(item_path.read_text())
    if f['id'] != item_id or f['properties']['proj:epsg'] != 32615:
        raise ValueError('Unexpected Sentinel item or projection')
    assets = {}
    paths = {}
    for band in ('green','swir16','scl','visual'):
        a = f['assets'][band]
        if not a['href'].startswith('https://sentinel-cogs.s3.us-west-2.amazonaws.com/sentinel-s2-l2a-cogs/'):
            raise ValueError('Unrecognized source for '+band)
        path = cache/(item_id+'-'+band+'.tif')
        download(a['href'], path)
        checksum=digest(path)
        if item_id in expected and checksum!=expected[item_id]['assets'][band]['sha256']:
            raise ValueError('Source band checksum changed; review the replacement before rebuilding.')
        assets[band] = dict(url=a['href'], sha256=checksum, transform=a['proj:transform'],
                            shape=a['proj:shape'], calibration=a.get('raster:bands',[]))
        paths[band] = path
    props = f['properties']
    source = dict(id=item_id, catalogUrl=CATALOG+item_id, product=props['s2:product_uri'],
                  acquiredAt=props['datetime'], platform=props['platform'], crs='EPSG:32615',
                  processingBaseline=props['s2:processing_baseline'], footprintBbox=f['bbox'],
                  assets=assets)
    return paths, source


def reference_window(ds):
    extent = transform_bounds('EPSG:4326', ds.crs, *BBOX)
    w = window_from_bounds(*extent, transform=ds.transform)
    left, top = max(0, math.floor(w.col_off)), max(0, math.floor(w.row_off))
    right = min(ds.width, math.ceil(w.col_off+w.width))
    bottom = min(ds.height, math.ceil(w.row_off+w.height))
    return Window(left, top, right-left, bottom-top)


def compute_granule(paths, source):
    with rasterio.open(paths['swir16']) as sw, rasterio.open(paths['green']) as green, \
         rasterio.open(paths['scl']) as scl, rasterio.open(paths['visual']) as visual:
        for key, ds in [('green',green),('swir16',sw),('scl',scl),('visual',visual)]:
            a = source['assets'][key]
            if ds.crs.to_epsg()!=32615 or list(ds.transform)[:6]!=a['transform'][:6] or [ds.height,ds.width]!=a['shape']:
                raise ValueError('COG and catalog geometry disagree: '+key)
        if sw.res!=(20,20) or green.res!=(10,10) or scl.transform!=sw.transform or visual.transform!=green.transform or \
           green.transform.c!=sw.transform.c or green.transform.f!=sw.transform.f:
            raise ValueError('Unexpected Sentinel band alignment')
        win = reference_window(sw)
        hi = Window(win.col_off*2,win.row_off*2,win.width*2,win.height*2)
        height,width=int(win.height),int(win.width)
        g = green.read(1, window=hi).reshape(height,2,width,2)
        s = sw.read(1,window=win)
        classes = scl.read(1,window=win)
        green_cal, swir_cal = [source['assets'][key]['calibration'][0] for key in ('green','swir16')]
        valid = np.isin(classes, [4,5,6]) & (s!=swir_cal['nodata']) & (g!=green_cal['nodata']).all(axis=(1,3))
        g = g.mean(axis=(1,3),dtype=np.float32)*green_cal['scale']+green_cal['offset']
        s = s.astype(np.float32)*swir_cal['scale']+swir_cal['offset']
        den=g+s
        valid &= (den>0) & (g>=0) & (s>=0)
        ratio=np.zeros_like(g)
        np.divide(g-s,den,out=ratio,where=valid)
        index=np.full(s.shape,NODATA,'int16')
        index[valid]=np.rint(ratio[valid]*10000).astype('int16')
        rgb=visual.read(window=hi,out_shape=(3,height,width),resampling=Resampling.average)
        return index,rgb,sw.window_transform(win)


def warp(source, transform, nodata=None):
    dest=np.zeros((HEIGHT,WIDTH),dtype=source.dtype)
    reproject(source,dest,src_transform=transform,src_crs='EPSG:32615',src_nodata=nodata,
              dst_transform=GRID,dst_crs='EPSG:4326',dst_nodata=nodata,
              resampling=Resampling.nearest)
    return dest


def build_date(cache,date,ids):
    mosaic=np.full((HEIGHT,WIDTH),NODATA,'int16')
    photo=np.zeros((HEIGHT,WIDTH,4),'uint8')
    sources=[]
    for item_id in ids:
        paths,source=read_granule(cache,item_id)
        sources.append(source)
        index,rgb,transform=compute_granule(paths,source)
        warped=warp(index,transform,NODATA)
        take=(mosaic==NODATA)&(warped!=NODATA)
        mosaic[take]=warped[take]
        for i in range(3):
            channel=warp(rgb[i],transform)
            photo[:,:,i][take]=channel[take]
    valid=mosaic!=NODATA
    photo[:,:,3]=valid.astype('uint8')*255
    folder=DATA/'water'
    folder.mkdir(exist_ok=True)
    water=folder/f'harvey-mndwi-{date}.webp'
    rgb=folder/f'harvey-rgb-{date}.webp'
    values=folder/f'harvey-index-{date}.png'
    Image.fromarray(photo).save(rgb,lossless=False,quality=87,method=4)
    encoded=np.zeros(mosaic.shape,'uint16')
    encoded[valid]=mosaic[valid].astype('int32')+10001
    Image.fromarray(encoded).save(values)
    # Piecewise linear, full-range color ramp. No spectral or clinical classification.
    for i in range(3):
        photo[:,:,i]=np.interp(mosaic,np.array([x for x,_ in PALETTE])*10000,
                                [color[i] for _,color in PALETTE]).round().astype('uint8')
    Image.fromarray(photo).save(water,lossless=True,method=4)
    info=dict(id='harvey-water-'+date,title=('Pre-Harvey' if date=='2017-08-15' else 'Harvey response')+' · '+date,
              date=date,acquiredAt=sources[0]['acquiredAt'],bbox=BBOX,crs='EPSG:4326',
              width=WIDTH,height=HEIGHT,analysisResolutionMeters=20,displayGrid='EPSG:4326; approximately 20 m per displayed pixel at Houston',validFraction=round(valid.mean(),6),
              validPixels=int(valid.sum()),pixelCount=int(valid.size),sources=sources)
    for key,path in [('water',water),('rgb',rgb),('index',values)]:
        info[key+'Url']='/data/water/'+path.name
        info[key+'Sha256']=digest(path)
    info.update(url=info['waterUrl'],sha256=info['waterSha256'])
    print(date,info['validFraction'],*[round(x.stat().st_size/1e6,1) for x in (water,rgb,values)],flush=True)
    return info


def check():
    m=json.loads(MANIFEST.read_text())
    assert [s['date'] for s in m['scenes']]==list(DATES)
    for scene in m['scenes']:
        assert scene['bbox']==BBOX and scene['crs']=='EPSG:4326'
        for key in ('water','rgb','index'):
            path=DATA/'water'/Path(scene[key+'Url']).name
            assert digest(path)==scene[key+'Sha256']
            with Image.open(path) as im:
                assert im.size==(WIDTH,HEIGHT)
                if key=='index':
                    index=np.asarray(im)
                    assert int((index>0).sum())==scene['validPixels'] and index.max()<=20001
                else:
                    alpha=np.asarray(im.convert('RGBA').getchannel('A'))
                    assert set(np.unique(alpha))=={0,255} and int((alpha>0).sum())==scene['validPixels']
            if key=='water':
                mask=alpha>0
            elif key=='rgb':
                assert np.array_equal(mask,alpha>0)
            else:
                assert np.array_equal(mask,index>0)
        assert scene['url']==scene['waterUrl'] and scene['acquiredAt'].startswith(scene['date'])
        for value,color in PALETTE:
            sample=round((value+1)*10000)+1
            # Spot check equal encoded index values against the exact lossless color ramp.
            rows,cols=np.nonzero(index[::16,::16]==sample)
            if len(rows):
                with Image.open(DATA/'water'/Path(scene['waterUrl']).name) as w:
                    assert w.getpixel((int(cols[0]*16),int(rows[0]*16)))==(*color,255)
    print('Verified dates, dimensions, hashes, masks, palette and quantitative index rasters.')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir',type=Path)
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    if args.check:
        check()
        return
    if not args.cache_dir:
        parser.error('Specify a cache outside the project for public satellite COGs.')
    args.cache_dir.mkdir(exist_ok=True,parents=True)
    scenes=[build_date(args.cache_dir,date,ids) for date,ids in DATES.items()]
    manifest=dict(schemaVersion=1,attribution='Contains modified Copernicus Sentinel data (2017), distributed through Earth Search.',
        description='Historical surface-water signal. Open water, including ordinary lakes and rivers, tends toward higher MNDWI. Cloud, shadow and missing observations are transparent. An index value does not establish flooding, depth, safety or accessibility.',
        method='Sentinel-2 L2A bottom-of-atmosphere reflectance. Average the four valid 10 m B03 samples on the native B11 20 m grid; apply source scale and offset to both bands. Compute (B03−B11)/(B03+B11). Accept only SCL 4 (vegetation), 5 (unvegetated) and 6 (water) with valid reflectance and positive denominator. Reproject each date separately with nearest-neighbor sampling to the common EPSG:4326 display grid. In same-date granule overlap use the first clear sample in source order.',
        rgbMethod='Same-granule TCI (B04/B03/B02), averaged from 10 m to the analysis grid. RGB and index use identical cloud/shadow/no-data masks. Colors are the display rendering in the source TCI.',
        indexEncoding='16-bit PNG sample 0 = no observation; otherwise MNDWI = (sample − 10001) / 10000. Georeferencing is the scene bbox and display dimensions. No threshold is applied.',
        legend=[dict(value=x,hex='#'+''.join(f'{n:02x}' for n in c)) for x,c in PALETTE],
        documentation=['https://sentiwiki.copernicus.eu/web/s2-products','https://docs.sentinel-hub.com/api/latest/data/sentinel-2-l2a/','https://science.data.nasa.gov/disasters/data-gallery/sentinel-2-mndwi'],
        scenes=scenes)
    MANIFEST.write_text(json.dumps(manifest,indent=2,ensure_ascii=False)+'\n')
    check()

if __name__=='__main__':
    main()
