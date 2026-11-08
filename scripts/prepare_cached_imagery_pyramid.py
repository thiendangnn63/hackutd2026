#!/usr/bin/env python3
"""Build offline EPSG:4326 detail from the public-domain USGS cached NAIP basemap.

Source256px EPSG:3857 tiles are cached outside the project, fetched with at most
six workers, and reprojected into the existing2048px geographic tile grid. Mesh
interpolation error is analytically bounded below. No runtime provider calls.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor,as_completed
import hashlib
import io
import json
import math
from pathlib import Path
import tempfile
import time
import urllib.request
from PIL import Image
import prepare_imagery_pyramid as base

SOURCE='https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer'
RADIUS=6378137.0
STRIP=64


def mercator(lon,lat):
    return RADIUS*math.radians(lon),RADIUS*math.asinh(math.tan(math.radians(lat)))


def pixels(lon,lat,level,grid):
    x,y=mercator(lon,lat)
    resolution=next(l['resolution'] for l in grid['lods'] if l['level']==level)
    return (x-grid['origin']['x'])/resolution,(grid['origin']['y']-y)/resolution


def source_range(tile,level,grid):
    w,s,e,n=tile['bbox'];left,top=pixels(w,n,level,grid);right,bottom=pixels(e,s,level,grid)
    cols,rows=grid['cols'],grid['rows']
    # Two source pixels beyond the destination footprint preserve bicubic edge support.
    c0,c1=math.floor((left-2)/cols),math.floor((right+2)/cols)
    r0,r1=math.floor((top-2)/rows),math.floor((bottom+2)/rows)
    return c0,c1,r0,r1,left,top,right,bottom


def source_path(cache,level,row,col):
    return cache/f'z{level}-r{row}-c{col}.img'


def fetch_source(identifier,cache,timeout,retries):
    level,row,col=identifier;path=source_path(cache,level,row,col)
    if path.exists():
        try:
            with Image.open(path) as image:
                if image.size==(256,256):image.verify();return identifier,None
        except Exception:path.unlink(missing_ok=True)
    url=f'{SOURCE}/tile/{level}/{row}/{col}';error=''
    for attempt in range(retries+1):
        try:
            with urllib.request.urlopen(url,timeout=timeout) as response:content=response.read(2*1024*1024)
            with Image.open(io.BytesIO(content)) as image:
                if image.size!=(256,256) or image.format not in ['JPEG','PNG']:raise ValueError('Unexpected cached image')
                image.verify()
            temp=path.with_suffix('.tmp');temp.write_bytes(content);temp.replace(path)
            return identifier,None
        except Exception as exc:
            error=f'{type(exc).__name__}: {exc}'[:240]
            if attempt<retries:time.sleep(min(4,attempt+1))
    return identifier,error


def warp_bound(bounds,height,level,grid):
    w,s,e,n=bounds;high=max(abs(s),abs(n));low=min(abs(s),abs(n))
    res=next(l['resolution'] for l in grid['lods'] if l['level']==level)
    # y(phi)=origin/res - R/res*asinh(tan(phi)); |y''|=R/res*sec(phi)*|tan(phi)|.
    second=RADIUS/res/abs(math.cos(math.radians(high)))*abs(math.tan(math.radians(high)))
    radians_per_row=math.radians(abs(n-s))/height
    source_error=second*(radians_per_row*STRIP)**2/8
    min_source_per_output=RADIUS/res/abs(math.cos(math.radians(low)))*radians_per_row
    return source_error/min_source_per_output if min_source_per_output else 0


def render(tile,level,grid,cache,quality):
    try:
        c0,c1,r0,r1,left,top,right,bottom=source_range(tile,level,grid)
        canvas=Image.new('RGBA',((c1-c0+1)*256,(r1-r0+1)*256),(0,0,0,0));digest=hashlib.sha256()
        for row in range(r0,r1+1):
            for col in range(c0,c1+1):
                content=source_path(cache,level,row,col).read_bytes();digest.update(hashlib.sha256(content).digest())
                with Image.open(io.BytesIO(content)) as image:canvas.paste(image.convert('RGBA'),((col-c0)*256,(row-r0)*256))
        width,height=tile['width'],tile['height'];w,s,e,n=tile['bbox'];mesh=[]
        for start in range(0,height,STRIP):
            end=min(height,start+STRIP)
            lat0=n-(n-s)*start/height;lat1=n-(n-s)*end/height
            sy0=pixels(w,lat0,level,grid)[1]-r0*256;sy1=pixels(w,lat1,level,grid)[1]-r0*256
            x0,x1=left-c0*256,right-c0*256
            mesh.append(((0,start,width,end),(x0,sy0,x0,sy1,x1,sy1,x1,sy0)))
        bound=warp_bound(tile['bbox'],height,level,grid)
        if bound>=.05:raise ValueError('Warp approximation exceeds0.05outputpixel bound')
        output=canvas.transform((width,height),Image.Transform.MESH,mesh,resample=Image.Resampling.BICUBIC)
        if output.getchannel('A').getextrema()==(255,255):output=output.convert('RGB')
        encoded=io.BytesIO();output.save(encoded,format='WEBP',quality=quality,method=4);content=encoded.getvalue()
        path=base.DIRECTORY/tile['file'];temp=path.with_suffix('.webp.tmp');temp.write_bytes(content);temp.replace(path)
        _,ymax=mercator(w,n);_,ymin=mercator(e,s);xmin,_=mercator(w,n);xmax,_=mercator(e,s)
        native=next(l['resolution'] for l in grid['lods'] if l['level']==level)*math.cos(math.radians((n+s)/2))
        return {**tile,'available':True,'status':'available','bytes':len(content),'sha256':hashlib.sha256(content).hexdigest(),
            'retrievedAt':base.timestamp(),'sourceUrl':SOURCE,'sourceCacheLevel':level,'sourceMetersPerPixel':native,
            'sourceTiles':{'rowMin':r0,'rowMax':r1,'columnMin':c0,'columnMax':c1,'count':(r1-r0+1)*(c1-c0+1)},
            'sourceDigest':digest.hexdigest(),'sourceExtent':{'xmin':xmin,'ymin':ymin,'xmax':xmax,'ymax':ymax,'spatialReference':{'wkid':3857}},
            'warpErrorOutputPixelsBound':bound,'failureReason':None},None
    except Exception as exc:
        error=f'{type(exc).__name__}: {exc}'[:300]
        return {**tile,'available':False,'status':'failed','failureReason':error},error


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--cache-dir',type=Path,default=Path(tempfile.gettempdir())/'beacon-naip-source-cache')
    parser.add_argument('--concurrency',type=int,default=6);parser.add_argument('--timeout',type=int,default=15);parser.add_argument('--retries',type=int,default=2)
    parser.add_argument('--quality',type=int,default=78);parser.add_argument('--levels',default='0,1,2,3');parser.add_argument('--metadata',type=Path,default=base.DATA/'houston-imagery-source.json')
    args=parser.parse_args();args.cache_dir.mkdir(exist_ok=True,parents=True)
    metadata=json.loads(args.metadata.read_text());grid=metadata['tileInfo']
    if grid['rows']!=256 or grid['cols']!=256 or grid['spatialReference'].get('latestWkid',grid['spatialReference'].get('wkid')) not in [3857,102100]:raise ValueError('Unexpected source cache grid')
    old=json.loads(base.MANIFEST.read_text()) if base.MANIFEST.exists() else {}
    for tier in old.get('tiers',[]):
        for tile in tier.get('tiles',[]):
            if tile.get('available') and not tile.get('sourceUrl','').startswith(SOURCE):(base.DIRECTORY/tile['file']).unlink(missing_ok=True)
    base.SOURCE=SOURCE;manifest=base.prepare()
    manifest.update(sourceUrl=SOURCE,attribution='USGS, USDA · USGSImageryOnly public-domain NAIP cache',
        date='Historical NAIP imagery, primarily2017–2021; acquisition varies by location',captureYear=None,
        license='Public domain USGS/USDA CONUS orthoimagery',
        serviceCopyrightText=metadata.get('copyrightText'),sourceNativeResolutionMeters=1,
        sourceCacheCRS='EPSG:3857',sourceCacheGrid={'origin':grid['origin'],'rows':256,'cols':256,'lods':[l for l in grid['lods'] if 13<=l['level']<=16]},
        sourceDocumentation='https://basemap.nationalmap.gov/arcgis/rest/services/USGSImageryOnly/MapServer',
        termsUrl='https://www.usgs.gov/faqs/are-there-any-restrictions-use-or-reproduction-usgs-data',
        processing=f'Public cached256px EPSG3857 source tiles;64rowPillowMESH EPSG4326 reprojection bounded<0.05outputpixels;WebPquality{args.quality};native no-data retained.',
        downloading=True,preparationState='downloading')
    manifest.pop('sourceMaxExportSize',None);base.publish(manifest)
    selected={int(n) for n in args.levels.split(',')}
    for tier in manifest['tiers']:
        if tier['level'] not in selected:continue
        level=13+tier['level'];tier['sourceCacheLevel']=level
        native=next(l['resolution'] for l in grid['lods'] if l['level']==level)*math.cos(math.radians((manifest['bbox'][1]+manifest['bbox'][3])/2))
        tier['sourceMetersPerPixel']=native
        pending=[t for t in tier['tiles'] if not t.get('available')]
        needed=set()
        for tile in pending:
            c0,c1,r0,r1,*_=source_range(tile,level,grid)
            needed.update((level,r,c) for r in range(r0,r1+1) for c in range(c0,c1+1))
        print(f'{tier["id"]}: {len(pending)} destination tiles, {len(needed)} unique cached source tiles, native{native:.2f}m/px',flush=True)
        failed={};done=0
        with ThreadPoolExecutor(max_workers=max(1,min(6,args.concurrency))) as pool:
            for future in as_completed([pool.submit(fetch_source,t,args.cache_dir,args.timeout,args.retries) for t in sorted(needed)]):
                identifier,error=future.result();done+=1
                if error:failed[identifier]=error
                if done%100==0 or done==len(needed):print(f'{tier["id"]} source cache {done}/{len(needed)}; failures{len(failed)}',flush=True)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures={pool.submit(render,t,level,grid,args.cache_dir,max(60,min(90,args.quality))):t for t in pending}
            for future in as_completed(futures):
                destination=futures[future];result,error=future.result();destination.update(result);base.publish(manifest)
                print(f'{tier["id"]} {result["id"]} {"FAILED" if error else "READY"} · {manifest["stats"]["availableTiles"]}/{manifest["stats"]["totalTiles"]} · {manifest["stats"]["bytes"]/1024/1024:.1f}MiB'+(f' · {error}' if error else ''),flush=True)
        print(f'{tier["id"]} complete: {sum(t.get("available",False) for t in tier["tiles"])}/{len(tier["tiles"])}',flush=True)
    manifest['downloading']=False;manifest['preparationState']='complete' if manifest['stats']['availableTiles']==manifest['stats']['totalTiles'] else 'partial';base.publish(manifest)
    print('Preparation finished:',manifest['stats'],flush=True)


if __name__=='__main__':main()
