#!/usr/bin/env python3
"""Cache real, dated NOAA NGS Harvey RGB imagery for offline geographic display.

NOAA's public 256px GoogleMapsCompatible WMTS is EPSG:3857. This script
reprojects its RGB mosaics to EPSG:4326 rectangles, retaining alpha/no-data.
It does not infer a flood mask, classify water, or place the xBD image pairs.
Requires Python 3.9+, Pillow, and requests only while preparing the assets.
Raw source tiles are cached outside the repository, under /tmp by default.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import io
import json
import math
from pathlib import Path
import time
import requests
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public' / 'data'
OUTPUT = DATA / 'flood-imagery'
MANIFEST = DATA / 'houston-flood-imagery.json'
TILE_URL = 'https://stormscdn.ngs.noaa.gov/{layer}/{z}/{x}/{y}'
WMTS_URL = 'https://storms.ngs.noaa.gov/storms/tilesd/services/tileserver.php/wmts?SERVICE=WMTS&REQUEST=GetCapabilities'
VIEWER_URL = 'https://storms.ngs.noaa.gov/storms/harvey/index.html'
METADATA_URL = 'https://www.fisheries.noaa.gov/inport/item/59048'
RADIUS = 6378137.0
STRIP = 32
BOUNDS = [-95.95, 29.50, -94.97, 30.15]
DATES = [
    ('2017-08-30', ['20170830-rgb']),
    ('2017-08-31', ['20170831a-rgb', '20170831b-rgb']),
    ('2017-09-01', ['20170901b-rgb']),
    ('2017-09-02', ['20170902c-rgb']),
    ('2017-09-03', ['20170903a-rgb']),
]
DETAILS = [
    ('2017-08-30', 'addicks', 'Addicks Reservoir', [-95.70, 29.755, -95.58, 29.855], ['20170830-rgb']),
    ('2017-08-30', 'barker', 'Barker Reservoir', [-95.72, 29.70, -95.63, 29.775], ['20170830-rgb']),
    ('2017-08-31', 'kingwood', 'Kingwood / West Fork San Jacinto', [-95.225, 29.98, -95.145, 30.045], ['20170831a-rgb']),
    ('2017-08-31', 'san-jacinto', 'Lake Houston / San Jacinto River', [-95.135, 29.815, -95.045, 29.92], ['20170831a-rgb']),
]


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def sha256(content):
    return hashlib.sha256(content).hexdigest()


def pixels(lon, lat, zoom):
    scale = 256 * 2 ** zoom
    return (lon + 180) / 360 * scale, (1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * scale


def source_range(bounds, zoom):
    west, south, east, north = bounds
    left, top = pixels(west, north, zoom)
    right, bottom = pixels(east, south, zoom)
    # Include interpolation support around the requested geographic rectangle.
    return math.floor((left - 2) / 256), math.floor((right + 2) / 256), math.floor((top - 2) / 256), math.floor((bottom + 2) / 256)


def spec(identifier, label, date, bounds, zoom, layers, role):
    left, top = pixels(bounds[0], bounds[3], zoom)
    right, bottom = pixels(bounds[2], bounds[1], zoom)
    return {'id': identifier, 'label': label, 'date': date, 'bbox': bounds, 'crs': 'EPSG:4326',
            'file': identifier + '.webp', 'path': '/data/flood-imagery/' + identifier + '.webp',
            'width': round(right - left), 'height': round(bottom - top), 'sourceCacheLevel': zoom,
            'sourceLayers': layers, 'role': role}


def specs():
    result = [spec('harvey-' + date.replace('-', '') + '-overview', 'Houston flight coverage', date, BOUNDS, 12, layers, 'overview') for date, layers in DATES]
    result += [spec('harvey-' + date.replace('-', '') + '-' + key, label, date, bounds, 16, layers, 'detail') for date, key, label, bounds, layers in DETAILS]
    return result


def tile_path(cache, identifier):
    layer, zoom, col, row = identifier
    # Also accepts the earlier visually checked public-source sample cache.
    return cache / f'{layer}-{zoom}-{col}-{row}.png'


def valid_source(image):
    return image.format in ('PNG', 'JPEG') and (image.size == (256, 256) or (image.size == (1, 1) and image.convert('RGBA').getchannel('A').getextrema() == (0, 0)))


def fetch(identifier, cache, offline, timeout):
    path = tile_path(cache, identifier)
    if path.exists():
        with Image.open(path) as image:
            if not valid_source(image):
                raise ValueError(f'Unexpected cached source tile: {path.name}')
            if image.size == (256, 256): image.verify()
        return identifier
    if offline:
        raise FileNotFoundError(f'Missing offline source tile: {path.name}')
    layer, zoom, col, row = identifier
    url = TILE_URL.format(layer=layer, z=zoom, x=col, y=row)
    for attempt in range(3):
        try:
            response = requests.get(url, timeout=timeout)
            response.raise_for_status()
            content = response.content
            if len(content) > 2_000_000:
                raise ValueError('Unexpected source tile size')
            with Image.open(io.BytesIO(content)) as image:
                if not valid_source(image):
                    raise ValueError('Unexpected public WMTS tile')
                if image.size == (256, 256): image.verify()
            temporary = path.with_suffix('.download')
            temporary.write_bytes(content)
            temporary.replace(path)
            return identifier
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)


def warp_error(bounds, height, zoom):
    # Linear mesh interpolation bound for y(phi) = C - R/res * asinh(tan(phi)).
    _, south, _, north = bounds
    high = math.radians(max(abs(south), abs(north)))
    low = math.radians(min(abs(south), abs(north)))
    resolution = 2 * math.pi * RADIUS / (256 * 2 ** zoom)
    radians_per_row = math.radians(north - south) / height
    second = RADIUS / resolution / abs(math.cos(high)) * abs(math.tan(high))
    source_error = second * (radians_per_row * STRIP) ** 2 / 8
    source_per_output = RADIUS / resolution / abs(math.cos(low)) * radians_per_row
    return source_error / source_per_output


def render(record, cache, quality):
    bounds, zoom = record['bbox'], record['sourceCacheLevel']
    col0, col1, row0, row1 = source_range(bounds, zoom)
    shape = ((col1 - col0 + 1) * 256, (row1 - row0 + 1) * 256)
    canvas = Image.new('RGBA', shape)
    digest = hashlib.sha256()
    nonempty = 0
    count = 0
    for layer in record['sourceLayers']:
        mosaic = Image.new('RGBA', shape)
        for row in range(row0, row1 + 1):
            for col in range(col0, col1 + 1):
                identifier = (layer, zoom, col, row)
                content = tile_path(cache, identifier).read_bytes()
                digest.update(('|'.join(map(str, identifier)) + ':' + sha256(content) + '\n').encode())
                with Image.open(io.BytesIO(content)) as image:
                    tile = image.convert('RGBA')
                    nonempty += bool(tile.getchannel('A').getbbox())
                    mosaic.paste(tile, ((col - col0) * 256, (row - row0) * 256))
                count += 1
        # Same-day Flight2 is drawn over Flight1 only where it has actual pixels.
        canvas.alpha_composite(mosaic)
    west, south, east, north = bounds
    width, height = record['width'], record['height']
    left, _ = pixels(west, north, zoom)
    right, _ = pixels(east, south, zoom)
    mesh = []
    for start in range(0, height, STRIP):
        end = min(height, start + STRIP)
        lat0 = north - (north - south) * start / height
        lat1 = north - (north - south) * end / height
        y0 = pixels(west, lat0, zoom)[1] - row0 * 256
        y1 = pixels(west, lat1, zoom)[1] - row0 * 256
        x0, x1 = left - col0 * 256, right - col0 * 256
        mesh.append(((0, start, width, end), (x0, y0, x0, y1, x1, y1, x1, y0)))
    bound = warp_error(bounds, height, zoom)
    if bound >= 0.05:
        raise ValueError('Geographic reprojection interpolation error exceeds 0.05 pixel')
    output = canvas.transform((width, height), Image.Transform.MESH, mesh, resample=Image.Resampling.BICUBIC)
    alpha = output.getchannel('A')
    histogram = alpha.histogram()
    coverage = sum(histogram[1:]) / (width * height)
    if not alpha.getbbox():
        raise ValueError('Empty image: no actual NOAA coverage in requested patch')
    path = OUTPUT / record['file']
    temporary = path.with_suffix('.webp.tmp')
    output.save(temporary, format='WEBP', quality=quality, method=4)
    temporary.replace(path)
    content = path.read_bytes()
    center = (north + south) / 2
    meters = math.cos(math.radians(center)) * 2 * math.pi * RADIUS / (256 * 2 ** zoom)
    return {**record, 'available': True, 'bytes': len(content), 'sha256': sha256(content),
            'coverageFraction': coverage, 'sourceMetersPerPixel': meters,
            'sourceTileRange': {'columnMin': col0, 'columnMax': col1, 'rowMin': row0, 'rowMax': row1},
            'sourceTileCount': count, 'nonemptySourceTileCount': nonempty, 'sourceDigest': digest.hexdigest(),
            'warpErrorOutputPixelsBound': bound, 'retrievedAt': timestamp()}


def check():
    manifest = json.loads(MANIFEST.read_text())
    count, total = 0, 0
    for day in manifest['imagery']:
        for record in [day['overview'], *day['detail']]:
            path = OUTPUT / record['file']
            content = path.read_bytes()
            assert sha256(content) == record['sha256'], path
            assert len(content) == record['bytes'], path
            assert record['date'] == day['date'], record['id']
            assert record['crs'] == 'EPSG:4326' and record['warpErrorOutputPixelsBound'] < 0.05
            assert 0 < record['coverageFraction'] <= 1
            with Image.open(path) as image:
                assert image.size == (record['width'], record['height']), path
                assert image.mode == 'RGBA', path
                assert image.getchannel('A').getbbox(), path
                if record['coverageFraction'] < 0.99:
                    assert image.getchannel('A').getextrema()[0] == 0, path
                image.load()
            count += 1
            total += len(content)
    assert count == 9
    print(f'Verified {count} dated georeferenced NOAA RGB images, {total:,} bytes; checksums, dimensions, dates, reprojection bounds, and real no-data transparency passed.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, default=Path('/tmp/hackutd-flood-cache'))
    parser.add_argument('--offline', action='store_true', help='Rebuild only from previously cached public source tiles')
    parser.add_argument('--offline-check', action='store_true', help='Verify bundled output without network')
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--timeout', type=int, default=30)
    parser.add_argument('--quality', type=int, default=85)
    args = parser.parse_args()
    if args.offline_check:
        check()
        return
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    records = specs()
    identifiers = set()
    for record in records:
        col0, col1, row0, row1 = source_range(record['bbox'], record['sourceCacheLevel'])
        identifiers.update((layer, record['sourceCacheLevel'], col, row) for layer in record['sourceLayers'] for row in range(row0, row1 + 1) for col in range(col0, col1 + 1))
    print(f'Preparing {len(identifiers)} bounded public NOAA source tiles for {len(records)} images.', flush=True)
    with ThreadPoolExecutor(max_workers=max(1, min(args.workers, 8))) as pool:
        jobs = [pool.submit(fetch, identifier, args.cache_dir, args.offline, args.timeout) for identifier in sorted(identifiers)]
        for index, job in enumerate(as_completed(jobs), 1):
            job.result()
            if index % 100 == 0 or index == len(jobs):
                print(f'Source cache {index}/{len(jobs)}', flush=True)
    rendered = {}
    for record in records:
        result = render(record, args.cache_dir, args.quality)
        rendered[result['id']] = result
        print(f"Rendered {result['id']}: {result['width']}x{result['height']}, {result['bytes']:,} bytes, {result['coverageFraction']:.1%} actual image coverage", flush=True)
    imagery = []
    for date, layers in DATES:
        identifier = 'harvey-' + date.replace('-', '')
        imagery.append({'id': identifier, 'date': date, 'label': 'Harvey aerial · ' + date,
                        'sourceLayers': layers, 'overview': rendered[identifier + '-overview'],
                        'detail': [value for value in rendered.values() if value['date'] == date and value['role'] == 'detail'],
                        'coverageNote': 'Partial NOAA flight coverage; transparent gaps are unavailable historical imagery, not evidence of dry ground.'})
    manifest = {
        'schemaVersion': 1, 'id': 'noaa-ngs-harvey-2017', 'available': True,
        'event': 'Hurricane Harvey', 'historical': True, 'crs': 'EPSG:4326', 'bbox': BOUNDS,
        'acquisitionDateRange': ['2017-08-30', '2017-09-03'], 'imagery': imagery,
        'attribution': 'NOAA National Geodetic Survey · Hurricane Harvey emergency-response RGB imagery (2017)',
        'source': {'agency': 'NOAA National Geodetic Survey, Remote Sensing Division',
                   'viewerUrl': VIEWER_URL, 'metadataUrl': METADATA_URL, 'capabilitiesUrl': WMTS_URL,
                   'tileUrlTemplate': TILE_URL, 'crs': 'EPSG:3857', 'tileMatrixSet': 'GoogleMapsCompatible',
                   'tileSize': 256, 'eventAcquisitionDateRange': ['2017-08-27', '2017-09-03'],
                   'product': 'Directly georeferenced emergency-response RGB mosaics; not a cadastral or navigation survey',
                   'nativeProductGroundSampleDistanceMetersApprox': 0.50,
                   'nativeResolutionNote': 'NOAA viewer reports approximately 50cm at zoom18. This bounded cache uses coarser zoom12 overview and zoom16 detail, with actual cached resolution recorded per image.',
                   'termsUrl': METADATA_URL,
                   'license': 'CC0-1.0', 'licenseUrl': 'https://creativecommons.org/publicdomain/zero/1.0/',
                   'licenseNote': 'NOAA InPort item59048 explicitly identifies this dataset as CC0-1.0, with no access restrictions.',
                   'horizontalAccuracyNote': 'NOAA says absolute horizontal positions should be in the 3–5m range in flat areas; accuracy has not been assessed.',
                   'useConstraints': 'NOAA public U.S. federal government imagery. Provided as-is for visual damage analysis and planning; no accuracy/completeness guarantee; not for navigation, charting, or surveying.'},
        'processing': {'rgb': 'Original NOAA true-color RGB; no water classification, color tint, synthetic imagery, or gap filling.',
                       'reprojection': 'EPSG3857 XYZ source pixels reprojected to EPSG4326 using 32-row Pillow bicubic mesh; interpolation error bound <0.05 output pixels.',
                       'encoding': 'WebP quality ' + str(args.quality) + '; original source alpha/no-data retained. NOAA all-transparent1px no-data responses are interpreted as empty256px source grid cells.',
                       'sameDayMosaicOrder': '2017-08-31 Flight1 then Flight2, with Flight2 only where source alpha has real imagery.',
                       'script': 'scripts/prepare_houston_flood_imagery.py', 'runtime': 'All image files are local; no runtime source requests.'},
        'limitations': ['Flight-strip coverage is nonuniform. Transparent pixels mean imagery unavailable, never an inferred flood or dry-land state.',
                        'Acquisition is an actual historical event date, not a current observation. Floodwater can be muddy brown or hidden by trees, clouds, and buildings.',
                        'Normal water bodies and floodwater both appear; these RGB pixels alone do not establish a precise flood boundary or emergency condition.',
                        'Geographic context only. These images do not establish assistance need, hospitality suitability, welfare, facility operation, or safe travel.',
                        'The separate xBD classifier study pairs have no verified Houston placement and are not used here.'],
        'preparedAt': timestamp(),
    }
    temporary = MANIFEST.with_suffix('.json.tmp')
    temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    temporary.replace(MANIFEST)
    check()


if __name__ == '__main__':
    main()
