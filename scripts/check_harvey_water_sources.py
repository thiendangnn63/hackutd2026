"""Verify delivered numeric values and masks against original COG pixels, without network.

Usage: python scripts/check_harvey_water_sources.py --cache-dir /path/to/preparation/cache
"""
import argparse
from contextlib import ExitStack
import json
import random

import numpy as np
from PIL import Image
import rasterio
from rasterio.warp import transform
from rasterio.windows import Window

from prepare_harvey_water import DATA, MANIFEST, GRID, WIDTH, HEIGHT


def check_sources(cache):
    manifest = json.loads(MANIFEST.read_text())
    rng = random.Random(20170830)
    # Exclude points near a source-pixel edge where warp approximation can change the nearest sample.
    pixels = [(rng.randrange(WIDTH), rng.randrange(HEIGHT)) for _ in range(250)]
    xs, ys = zip(*(GRID * (c+.5,r+.5) for c,r in pixels))
    east, north = transform('EPSG:4326','EPSG:32615',xs,ys)
    for scene in manifest['scenes']:
        index = np.asarray(Image.open(DATA/'water'/scene['indexUrl'].split('/')[-1]))
        with ExitStack() as stack:
            tiles=[]
            for source in scene['sources']:
                inputs={k:stack.enter_context(rasterio.open(cache/(source['id']+'-'+k+'.tif')))
                        for k in ('green','swir16','scl')}
                tiles.append((inputs,source))
            checked=observed=masked=0
            for (c,r),x,y in zip(pixels,east,north):
                values=[]
                stable=True
                for tile,source in tiles:
                    sw=tile['swir16']
                    col,row=~sw.transform*(x,y)
                    if not(0<=col<sw.width and 0<=row<sw.height):
                        continue
                    if min(col%1,1-col%1,row%1,1-row%1)<.2:
                        stable=False
                        break
                    win=Window(int(col),int(row),1,1)
                    scl=int(tile['scl'].read(1,window=win)[0,0])
                    if scl not in (4,5,6):
                        continue
                    s=float(sw.read(1,window=win)[0,0])
                    gs=tile['green'].read(1,window=Window(2*int(col),2*int(row),2,2))
                    cg=source['assets']['green']['calibration'][0]
                    cs=source['assets']['swir16']['calibration'][0]
                    if s==cs['nodata'] or np.any(gs==cg['nodata']):
                        continue
                    g=float(gs.mean())*cg['scale']+cg['offset']
                    s=s*cs['scale']+cs['offset']
                    if min(g,s)>=0 and g+s>0:
                        values.append((g-s)/(g+s))
                        break
                if not stable:
                    continue
                got=int(index[r,c])
                if values:
                    assert got!=0 and abs((got-10001)/10000-values[0])<=.000051,(scene['date'],c,r,got,values)
                    observed+=1
                else:
                    assert got==0,(scene['date'],c,r,got,'masked')
                    masked+=1
                checked+=1
            assert checked>=45 and observed>0 and masked>0
            print(f"{scene['date']}: {checked} direct COG pixel checks ({observed} observed, {masked} masked).")


if __name__=='__main__':
    from pathlib import Path
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir',type=Path,required=True)
    check_sources(parser.parse_args().cache_dir)
