"""Crop NASA/JPL ARIA's georeferenced Harvey flood proxy. Run with --cache-dir or --check."""
import argparse
import json
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image
from rasterio.enums import Resampling
from rasterio.io import MemoryFile
from rasterio.transform import from_bounds
from rasterio.warp import reproject
from prepare_harvey_water import DATA, BBOX, download, digest

SOURCE='https://d1z62tir4fw0q0.cloudfront.net/201708-Hurricane_Harvey/ARIA_FPM_Sentinel-1_v0.2_GeoTIFF.zip'
SHA='c4bdf14daa1939ec541e7125a25ba371d8d34da43dc5d3e1b10d077b62a750b2'
PAGE='https://www.jpl.nasa.gov/images/pia21932-new-nasa-satellite-flood-map-of-southeastern-texas-sentinel-1-data/'
WIDTH,HEIGHT=3050,2440
IMAGE=DATA/'water/harvey-radar-proxy-2017-08-29.webp'
META=DATA/'houston-radar-imagery.json'


def build(cache):
    cache.mkdir(parents=True,exist_ok=True)
    source=cache/'aria-harvey-radar.zip'
    download(SOURCE,source)
    if digest(source)!=SHA:
        raise ValueError('Original ARIA ZIP changed; review provenance before rebuilding.')
    out=np.zeros((HEIGHT,WIDTH),'uint8')
    grid=from_bounds(*BBOX,WIDTH,HEIGHT)
    used=[]
    with zipfile.ZipFile(source) as archive:
        for name in archive.namelist():
            with MemoryFile(archive.read(name)) as mem,mem.open() as ds:
                if ds.crs.to_epsg()!=4326 or ds.count!=4 or ds.colorinterp[-1].name!='alpha':
                    raise ValueError('Unexpected radar proxy grid or channels')
                west,south,east,north=ds.bounds
                if east<=BBOX[0] or north<=BBOX[1] or west>=BBOX[2] or south>=BBOX[3]:
                    continue
                alpha=ds.read(4)
                if not np.isin(alpha,[0,255]).all():
                    raise ValueError('Unexpected ARIA probability/alpha encoding')
                # Published tiles contain one symbol (light blue) for likely inundation.
                for band,value in enumerate([100,200,255],start=1):
                    if not np.all(ds.read(band)[alpha>0]==value):
                        raise ValueError('Unexpected radar map symbol')
                warped=np.zeros_like(out)
                reproject(alpha,warped,src_transform=ds.transform,src_crs=ds.crs,
                          dst_transform=grid,dst_crs='EPSG:4326',resampling=Resampling.nearest)
                np.maximum(out,warped,out=out)
                used.append({'name':name,'bbox':list(ds.bounds),'shape':[ds.height,ds.width]})
    assert 0<np.count_nonzero(out)<out.size
    rgba=np.zeros((HEIGHT,WIDTH,4),'uint8')
    rgba[:,:,:3]=[100,200,255];rgba[:,:,3]=out
    IMAGE.parent.mkdir(exist_ok=True)
    Image.fromarray(rgba).save(IMAGE,lossless=True,method=4)
    metadata=dict(schemaVersion=1,id='harvey-sentinel1-proxy-20170829',title='Sentinel-1 radar flood proxy',
        date='2017-08-29',comparedDate='2017-08-05',published='2017-08-31',bbox=BBOX,crs='EPSG:4326',
        width=WIDTH,height=HEIGHT,analysisResolutionMeters=30,url='/data/water/'+IMAGE.name,
        sha256=digest(IMAGE),indicatedPixels=int(np.count_nonzero(out)),pixelCount=out.size,
        description='Light blue marks NASA ARIA’s likely inundation signal from Sentinel-1 radar change between August 5 and 29. Unmarked areas have no positive indication in the published product. Their flood status is unknown. The proxy can miss flooding in built-up areas.',
        legend=[dict(color='#64c8ff',label='Probable inundation indicated by NASA ARIA'),dict(color='transparent',label='No positive proxy indication; flood status unknown')],
        limitations='A missing indication does not establish dry ground. The proxy is less reliable over urban areas. It cannot establish water depth, welfare, access or safe travel.',
        method='Nearest-neighbor reprojection of the source GeoTIFF alpha symbols onto the bounded map. Overlapping granule indications are combined. Original indication color is preserved. No optical interpolation, flood classification, or dry class was added.',
        attribution='Contains modified Copernicus Sentinel data (2017), processed by ESA and analyzed by NASA/JPL-Caltech ARIA.',
        sourcePage=PAGE,sourceUrl=SOURCE,sourceSha256=SHA,sourceVersion='ARIA FPM Sentinel-1 v0.2',granules=used)
    META.write_text(json.dumps(metadata,indent=2,ensure_ascii=False)+'\n')


def check():
    metadata=json.loads(META.read_text())
    assert digest(IMAGE)==metadata['sha256'] and metadata['bbox']==BBOX
    with Image.open(IMAGE) as im:
        assert im.size==(WIDTH,HEIGHT)
        rgba=np.asarray(im.convert('RGBA'));active=rgba[:,:,3]>0
        assert set(np.unique(rgba[:,:,3]))=={0,255}
        assert np.all(rgba[:,:,:3][active]==[100,200,255]) and active.sum()==metadata['indicatedPixels']
    print(f"Verified {len(metadata['granules'])} georeferenced ARIA input granules and {metadata['indicatedPixels']} published indicator pixels.")


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir',type=Path)
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    if not args.check:
        if not args.cache_dir:
            parser.error('Specify the external source cache.')
        build(args.cache_dir)
    check()
