#!/usr/bin/env python3
"""Prepare a resumable, offline-only historical Texas/USDA NAIP raster pyramid.

The official Texas2022NAIP ImageServer supports up to15000×4100px exports. This downloader
uses 2048px exports and at most four concurrent read-only requests. No app runtime
calls this service. Raster coordinates and real transparent no-data are preserved;
WebP is a storage encoding, never generated geographic content.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import datetime
import hashlib
import io
import json
import math
from pathlib import Path
import time
import urllib.parse
import urllib.request
from PIL import Image
from shapely.geometry import box, shape

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public' / 'data'
MANIFEST = DATA / 'houston-imagery-pyramid.json'
DIRECTORY = DATA / 'imagery'
SOURCE = 'https://imagery.geographic.texas.gov/server/rest/services/NAIP/NAIP22_NCCIR_60cm/ImageServer'
GRIDS = [(2, 2), (4, 3), (8, 6), (16, 12)]
PIXELS = 2048


def timestamp():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def meters_per_pixel(bounds, width, height):
    west, south, east, north = bounds
    return max((east-west)*111320*math.cos(math.radians((north+south)/2))/width,
               (north-south)*111320/height)


def publish(manifest):
    manifest['updatedAt'] = timestamp()
    tiles = [tile for tier in manifest['tiers'] for tile in tier['tiles']]
    manifest['stats'] = dict(totalTiles=len(tiles), availableTiles=sum(t.get('available', False) for t in tiles),
                             bytes=sum(t.get('bytes', 0) for t in tiles if t.get('available')),
                             failedTiles=sum(t.get('status') == 'failed' for t in tiles))
    manifest['available'] = manifest['stats']['availableTiles'] > 0
    manifest['complete'] = bool(tiles) and manifest['stats']['availableTiles'] == len(tiles)
    temp = MANIFEST.with_suffix('.json.tmp')
    temp.write_text(json.dumps(manifest, separators=(',', ':'))+'\n')
    temp.replace(MANIFEST)


def prepare():
    if DATA.is_symlink():
        raise ValueError('Detach/copy the staging data directory before writing imagery assets')
    DIRECTORY.mkdir(exist_ok=True)
    city = shape(json.loads((DATA / 'houston-city.json').read_text())['geometry'])
    footprint = city.buffer(.015)  # Approximately 1.5km geographic context around real city polygons.
    west, south, east, north = city.bounds
    bounds = [west-.02, south-.02, east+.02, north+.02]
    old = json.loads(MANIFEST.read_text()) if MANIFEST.exists() else {}
    cached = {t['id']: t for tier in old.get('tiers', []) for t in tier.get('tiles', [])}
    tiers = []
    for level, (columns, rows) in enumerate(GRIDS):
        width, height = columns*PIXELS, rows*PIXELS
        tier = dict(id=f'naip-{width//1024}k', level=level, width=width, height=height,
                    tileWidth=PIXELS, tileHeight=PIXELS, columns=columns, rows=rows,
                    metersPerPixel=meters_per_pixel(bounds, width, height), tiles=[])
        for row in range(rows):
            for col in range(columns):
                w = bounds[0]+(bounds[2]-bounds[0])*col/columns
                e = bounds[0]+(bounds[2]-bounds[0])*((col+1)/columns)
                n = bounds[3]-(bounds[3]-bounds[1])*row/rows
                s = bounds[3]-(bounds[3]-bounds[1])*((row+1)/rows)
                if not box(w, s, e, n).intersects(footprint):
                    continue
                identifier = f'naip-l{level}-r{row:02d}-c{col:02d}'
                tile = dict(id=identifier, file=identifier+'.webp', bbox=[w, s, e, n], width=PIXELS,
                            height=PIXELS, row=row, column=col, available=False, status='pending',
                            metersPerPixel=meters_per_pixel([w, s, e, n], PIXELS, PIXELS))
                previous = cached.get(identifier)
                path = DIRECTORY/tile['file']
                if previous and previous.get('sourceUrl','').startswith(SOURCE) and len(previous.get('bbox',[]))==4 and all(abs(a-b)<1e-9 for a,b in zip(previous['bbox'],tile['bbox'])) and path.exists():
                    content = path.read_bytes()
                    if hashlib.sha256(content).hexdigest() == previous.get('sha256'):
                        with Image.open(io.BytesIO(content)) as image:
                            image.load()
                            if image.size == (PIXELS, PIXELS):
                                tile.update({k: v for k, v in previous.items() if k not in ['url']})
                                tile.update(available=True, status='available')
                tier['tiles'].append(tile)
        tiers.append(tier)
    manifest = dict(schemaVersion=1, available=False, crs='EPSG:4326', bbox=bounds,
                    historical=True, sourceUrl=SOURCE, sourceDocumentation='https://developers.arcgis.com/rest/services-reference/enterprise/export-image/',
                    attribution='Texas Geographic Information Office, USDA · NAIP2022', license='Public domain USDA NAIP imagery; unrestricted Texas NAIP service',
                    date='Historical Texas NAIP2022; statewide acquisition May–September2022; exact per-tile capture dates are not supplied',
                    serviceCopyrightText='Texas Geographic Information Office, USDA',captureYear=2022,downloading=False,
                    termsUrl='https://geographic.texas.gov/texas-imagery-service',catalogUrl='https://catalog.data.gov/dataset/national-agriculture-imagery-program-naip-imagery',
                    sourceNativeResolutionMeters=.6, sourceMaxExportSize=[15000,4100],
                    processing='Exact EPSG:4326 export rectangles; original no-data transparency retained; encoded WebP quality82 for offline delivery.',
                    coverage='Sparse tiles intersecting full-purpose Houston plus approximately1.5km buffer; surrounding metro/NASA context remains underneath.',
                    tiers=tiers)
    publish(manifest)
    return manifest


def download(tile, timeout, retries, cached_export=None):
    if tile.get('available'):
        return tile, None, True
    params = dict(bbox=','.join(format(n, '.14g') for n in tile['bbox']), bboxSR=4326, imageSR=4326,
                  size=f'{PIXELS},{PIXELS}', format='jpgpng', compressionQuality=85,
                  noData=0, noDataInterpretation='esriNoDataMatchAll', interpolation='RSP_BilinearInterpolation',
                  bandIds='0,1,2', adjustAspectRatio='false', f='json')
    url = SOURCE+'/exportImage?'+urllib.parse.urlencode(params)
    error = ''
    for attempt in range(retries+1):
        try:
            if cached_export is not None:
                exported = cached_export
                cached_export = None
            else:
                request = urllib.request.Request(url, headers={'User-Agent': 'Beacon-offline-map-preparation/1.0'})
                with urllib.request.urlopen(request, timeout=timeout) as response:
                    exported = json.loads(response.read(1024*1024))
            extent = exported.get('extent', {})
            actual = [extent.get(k) for k in ['xmin','ymin','xmax','ymax']]
            spatial = extent.get('spatialReference', {})
            if exported.get('width') != PIXELS or exported.get('height') != PIXELS or spatial.get('latestWkid',spatial.get('wkid')) != 4326:
                raise ValueError('Source returned incorrect image size or CRS')
            if not all(isinstance(n,(int,float)) and math.isfinite(n) for n in actual) or not all(abs(a-b)<1e-8 for a,b in zip(actual,tile['bbox'])):
                raise ValueError('Source returned a geographic extent different from the requested rectangle')
            href = exported.get('href','')
            parsed = urllib.parse.urlparse(href)
            if parsed.scheme != 'https' or parsed.hostname != 'imagery.geographic.texas.gov':
                raise ValueError('Source image href must remain on the official Texas imagery host')
            with urllib.request.urlopen(href, timeout=timeout) as response:
                content = response.read(32*1024*1024+1)
            if len(content) > 32*1024*1024:
                raise ValueError('Unexpected image response size')
            with Image.open(io.BytesIO(content)) as image:
                image.load()
                source_format = image.format
                if image.size != (PIXELS, PIXELS) or source_format not in ['JPEG', 'PNG']:
                    raise ValueError('Source returned incorrect image dimensions or format')
                mode = 'RGBA' if 'A' in image.getbands() else 'RGB'
                converted = image.convert(mode)
                output = io.BytesIO()
                converted.save(output, format='WEBP', quality=82, method=4)
                encoded = output.getvalue()
            path = DIRECTORY/tile['file']
            temporary = path.with_suffix('.webp.tmp')
            temporary.write_bytes(encoded)
            temporary.replace(path)
            result = {**tile, 'available': True, 'status': 'available', 'bytes': len(encoded),
                      'sha256': hashlib.sha256(encoded).hexdigest(), 'retrievedAt': timestamp(),
                      'sourceUrl': url, 'sourceFormat': source_format, 'requestedBbox': tile['bbox'], 'bbox': actual,
                      'sourceExtent': extent, 'sourceWidth': exported['width'], 'sourceHeight': exported['height'], 'failureReason': None}
            return result, None, False
        except Exception as exc:
            error = f'{type(exc).__name__}: {exc}'[:350]
            if attempt < retries:
                time.sleep(min(8, 2**(attempt+1)))
    return {**tile, 'available': False, 'status': 'failed', 'failureReason': error}, error, False


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--manifest-only', action='store_true')
    parser.add_argument('--concurrency', type=int, default=4)
    parser.add_argument('--timeout', type=int, default=40)
    parser.add_argument('--retries', type=int, default=1)
    parser.add_argument('--levels', default='0,1,2,3')
    args = parser.parse_args()
    manifest = prepare()
    print('Manifest ready:', [(t['id'], len(t['tiles']), round(t['metersPerPixel'], 2)) for t in manifest['tiers']], flush=True)
    if args.manifest_only:
        return
    manifest['downloading']=True;manifest['preparationState']='downloading';publish(manifest)
    selected = {int(n) for n in args.levels.split(',')}
    for tier in manifest['tiers']:
        if tier['level'] not in selected:
            continue
        tiles = sorted(tier['tiles'], key=lambda t: ((t['bbox'][0]+t['bbox'][2])/2+95.3698)**2+((t['bbox'][1]+t['bbox'][3])/2-29.7604)**2)
        by_id = {tile['id']: tile for tile in tier['tiles']}
        with ThreadPoolExecutor(max_workers=max(1, min(4, args.concurrency))) as pool:
            tasks = [pool.submit(download, tile, args.timeout, max(0, min(2, args.retries))) for tile in tiles]
            for future in as_completed(tasks):
                tile, error, cached = future.result()
                by_id[tile['id']].update(tile)
                publish(manifest)
                print(f"{tier['id']} {tile['id']} {'CACHED' if cached else 'FAILED' if error else 'READY'} · {manifest['stats']['availableTiles']}/{manifest['stats']['totalTiles']} tiles · {manifest['stats']['bytes']/1024/1024:.1f} MiB" + (f' · {error}' if error else ''), flush=True)
        print('Tier complete:', tier['id'], sum(t.get('available', False) for t in tier['tiles']), '/', len(tier['tiles']), flush=True)
    manifest['downloading']=False;manifest['preparationState']='complete' if manifest['stats']['availableTiles']==manifest['stats']['totalTiles'] else 'partial';publish(manifest)
    print('Preparation finished:', manifest['stats'], flush=True)


if __name__ == '__main__':
    main()
