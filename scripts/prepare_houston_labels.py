#!/usr/bin/env python3
"""Prepare offline street/landmark context from official public GIS snapshots.

Build-time only: python3 scripts/prepare_houston_labels.py [--offline]
Dependencies: requests and shapely. Raw responses are cached under /tmp, never in
Git or the vault. The browser consumes only the three compact output JSON files.
"""
import argparse
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import gzip
import hashlib
import json
import math
from pathlib import Path
import time
import requests
from shapely.geometry import shape, mapping, Polygon, MultiPolygon, Point, LineString, box
from shapely.ops import linemerge, unary_union

ROOT = Path(__file__).resolve().parents[1]
CACHE = Path('/tmp/hackutd-label-cache/responses')
AGOL = 'https://services.arcgis.com/NummVBqZSIJKUeVR/arcgis/rest/services/'
ROADS = AGOL + 'COH_RoadCenterline/FeatureServer/0'
SOURCES = {
    'coh-roads': {'title': 'Houston Road Centerline', 'url': ROADS, 'itemId': '26c92bc89c5d4b048d9bc8bcb7dfbff6', 'attribution': 'City of Houston Planning and Development / COHGIS'},
    'coh-parks': {'title': 'Parks (City of Houston)', 'url': AGOL + 'COH_Parks_view/FeatureServer/14', 'itemId': '13a5b57472b040ad85f5a8a74aa07c03', 'attribution': 'City of Houston / COHGIS'},
    'coh-airports': {'title': 'Houston Airports', 'url': AGOL + 'COH_Airports_view/FeatureServer/18', 'itemId': '0b4d0df2e67b46d8b3300d61ed631d9f', 'attribution': 'City of Houston / COHGIS'},
    'coh-libraries': {'title': 'Houston Libraries', 'url': AGOL + 'COH_Libraries_view/FeatureServer/12', 'itemId': '09e1faab0f6c46208cdc737fed858253', 'attribution': 'City of Houston / COHGIS'},
    'usgs-city-halls': {'title': 'City/Town Halls', 'url': 'https://carto.nationalmap.gov/arcgis/rest/services/structures/MapServer/39', 'attribution': 'USGS The National Map / National Structures Dataset'},
}
ROAD_CLASSES = ['FREEWAY', 'HIGHWAY', 'TOLLWAY', 'MAJOR', 'MINOR', 'LOCAL']
RANK = {'FREEWAY': 0, 'HIGHWAY': 0, 'TOLLWAY': 0, 'MAJOR': 1, 'MINOR': 1, 'LOCAL': 2}
CITY_NOTICE = 'City GIS is provided for general reference, without assurance of accuracy or completeness; it is not an on-the-ground survey or a substitute for independent verification.'


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


def fetch(url, params=None):
    params = {'f': 'json', **(params or {})}
    key = hashlib.sha256((url + compact(sorted(params.items()))).encode()).hexdigest()
    path = CACHE / (key + '.json.gz')
    if path.exists():
        with gzip.open(path, 'rt') as file:
            return json.load(file)
    if ARGS.offline:
        raise RuntimeError(f'Offline cache miss: {url} {key}')
    error = None
    for attempt in range(4):
        try:
            response = requests.get(url, params=params, timeout=90)
            response.raise_for_status()
            result = response.json()
            if result.get('error'):
                raise RuntimeError(str(result['error']))
            CACHE.mkdir(parents=True, exist_ok=True)
            with gzip.open(path, 'wt') as file:
                file.write(compact(result))
            return result
        except Exception as exc:
            error = f'{type(exc).__name__}: HTTP {getattr(getattr(exc, "response", None), "status_code", "unavailable")}'
            time.sleep(attempt + 1)
    raise RuntimeError(f'Official source failed: {url}: {error}')


def records(source, fields, extent, where='1=1'):
    params = {'where': where, 'geometry': ','.join(map(str, extent)), 'geometryType': 'esriGeometryEnvelope', 'inSR': '4326', 'spatialRel': 'esriSpatialRelIntersects'}
    ids = sorted(fetch(source + '/query', {**params, 'returnIdsOnly': 'true'}).get('objectIds') or [])
    chunks = [ids[i:i + 1800] for i in range(0, len(ids), 1800)]

    def chunk(part):
        result = fetch(source + '/query', {**params, 'where': f'({where}) AND OBJECTID >= {part[0]} AND OBJECTID <= {part[-1]}', 'outFields': ','.join(fields), 'orderByFields': 'OBJECTID', 'resultRecordCount': '2000', 'returnGeometry': 'true', 'outSR': '4326', 'returnZ': 'false', 'returnM': 'false', 'geometryPrecision': '7'})
        features = result.get('features', [])
        actual_ids = {next((value for key, value in feature.get('attributes', {}).items() if key.lower() == 'objectid'), None) for feature in features}
        if result.get('exceededTransferLimit') or actual_ids != set(part):
            raise RuntimeError(f'Incomplete official-source response: expected {len(part)}, received {len(features)}')
        return features

    with ThreadPoolExecutor(max_workers=6) as pool:
        batches = list(pool.map(chunk, chunks))
    features = [item for batch in batches for item in batch]
    if len(features) != len(ids):
        raise RuntimeError('Feature count differs from frozen source object-ID membership')
    for feature in features:
        lookup = {key.lower(): value for key, value in feature.get('attributes', {}).items()}
        feature['attributes'] = {field: lookup.get(field.lower()) for field in fields}
    return features


def lines(geometry):
    if geometry.is_empty:
        return []
    if geometry.geom_type == 'LineString':
        return [geometry]
    if geometry.geom_type in ('MultiLineString', 'GeometryCollection'):
        return [line for part in geometry.geoms for line in lines(part)]
    return []


def polygon(geometry):
    # ArcGIS rings encode outer/hole orientation; symmetric difference also handles
    # multipart outers and holes without assigning guessed parent polygons.
    rings = [Polygon(ring) for ring in geometry.get('rings', []) if len(ring) >= 4]
    result = Polygon()
    for ring in rings:
        if not ring.is_valid:
            ring = ring.buffer(0)
        result = result.symmetric_difference(ring)
    return result


def meters(line):
    total = 0
    for (lon1, lat1), (lon2, lat2) in zip(line.coords, list(line.coords)[1:]):
        dx = math.radians(lon2 - lon1) * math.cos(math.radians((lat1 + lat2) / 2))
        dy = math.radians(lat2 - lat1)
        total += 6371008.8 * math.hypot(dx, dy)
    return total


def prepare_streets(extent, context):
    where = "roadclass IN ('FREEWAY','HIGHWAY','TOLLWAY','MAJOR','MINOR','LOCAL') AND fullname IS NOT NULL"
    raw = records(ROADS, ['OBJECTID', 'fullname', 'roadclass'], extent, where)
    grouped = defaultdict(list)
    for item in raw:
        props, geometry = item['attributes'], item.get('geometry') or {}
        name = (props.get('fullname') or '').strip()
        road_class = props.get('roadclass')
        if not name or road_class not in RANK:
            continue
        for coordinates in geometry.get('paths', []):
            if len(coordinates) < 2:
                continue
            line = LineString([p[:2] for p in coordinates])
            if line.intersects(context):
                grouped[(name, road_class)].extend(lines(line.intersection(context)))
    output = []
    for (name, road_class), fragments in sorted(grouped.items()):
        if not fragments:
            continue
        merged = unary_union(fragments)
        if merged.geom_type != 'LineString':
            merged = linemerge(merged)
        parts = sorted(lines(merged), key=lambda line: tuple(line.bounds) + (line.length,))
        for i, line in enumerate(parts):
            if meters(line) < (18 if RANK[road_class] == 2 else 8):
                continue
            # ~1.3–1.7 m at Houston latitude: end points/topology are retained.
            line = line.simplify(0.000015, preserve_topology=True)
            coordinates = [[round(x, 6), round(y, 6)] for x, y in line.coords]
            coordinates = [p for j, p in enumerate(coordinates) if j == 0 or p != coordinates[j - 1]]
            if len(coordinates) < 2:
                continue
            line = LineString(coordinates)
            length = meters(line)
            point = line.interpolate(.5, normalized=True)
            stable = hashlib.sha256((name + '|' + road_class).encode()).hexdigest()[:12]
            output.append({'type': 'Feature', 'geometry': {'type': 'LineString', 'coordinates': coordinates}, 'properties': {
                'id': f'coh-road-{stable}-{i}', 'name': name, 'rank': RANK[road_class], 'sourceClass': road_class,
                'source': 'coh-roads', 'lengthM': round(length, 1), 'labelPoint': [round(point.x, 6), round(point.y, 6)],
                'bbox': [round(n, 6) for n in line.bounds],
            }})
    output.sort(key=lambda f: (f['properties']['rank'], -f['properties']['lengthM'], f['properties']['name'], f['properties']['id']))
    # Preserve every connected path but avoid repeating feature metadata at every
    # street intersection. The browser computes projected bounds/label placement.
    named_paths = defaultdict(list)
    for feature in output:
        named_paths[(feature['properties']['name'], feature['properties']['rank'])].append(feature['geometry']['coordinates'])
    features = []
    for (name, rank), parts in sorted(named_paths.items(), key=lambda item: (item[0][1], item[0][0])):
        features.append({'type': 'Feature', 'properties': {'name': name, 'rank': rank},
                         'geometry': {'type': 'LineString' if len(parts) == 1 else 'MultiLineString',
                                      'coordinates': parts[0] if len(parts) == 1 else parts}})
    return features, len(raw), len(output)


def prepare_landmarks(extent, context):
    definitions = [
        ('coh-parks', ['OBJECTID', 'Name', 'Park_Acres', 'Park_Type'], 'Name', 'park'),
        ('coh-airports', ['OBJECTID', 'NAME', 'ACREAGE'], 'NAME', 'airport'),
        ('coh-libraries', ['OBJECTID', 'LIBRARY'], 'LIBRARY', 'library'),
        ('usgs-city-halls', ['OBJECTID', 'NAME', 'CITY', 'GNIS_ID'], 'NAME', 'civic'),
    ]
    output, raw_counts, airports = [], {}, {}
    for source_id, fields, name_field, kind in definitions:
        raw = records(SOURCES[source_id]['url'], fields, extent)
        raw_counts[source_id] = len(raw)
        for item in raw:
            props, geometry = item['attributes'], item.get('geometry') or {}
            name = (props.get(name_field) or '').strip()
            if not name:
                continue
            if 'x' in geometry:
                point, method, area = Point(geometry['x'], geometry['y']), 'source_point', 0
            elif geometry.get('rings'):
                footprint = polygon(geometry)
                if footprint.is_empty or not footprint.intersects(context):
                    continue
                point, method, area = footprint.representative_point(), 'interior_label_point_from_source_polygon', footprint.area
            else:
                continue
            if not context.covers(point):
                continue
            acreage = float(props.get('Park_Acres') or props.get('ACREAGE') or 0)
            if kind == 'airport':
                rank = 0 if acreage >= 1000 else 1
            elif kind == 'park':
                rank = 0 if acreage >= 1000 else 1 if acreage >= 100 else 2
            elif kind == 'civic':
                rank = 0 if name.casefold() == 'houston city hall' else 2
            else:
                rank = 1 if any(word in name.lower() for word in ['central', 'ideson']) else 2
            feature = {'type': 'Feature', 'geometry': {'type': 'Point', 'coordinates': [round(point.x, 6), round(point.y, 6)]}, 'properties': {
                'id': f'{source_id}-{props["OBJECTID"]}', 'name': name, 'kind': kind, 'rank': rank, 'source': source_id,
                'contextOnly': True, 'positionMethod': method,
            }}
            if kind == 'airport':
                # The City layer contains separate runway and campus polygons with
                # the same airport name. Use the largest source footprint once.
                if name not in airports or area > airports[name][0]:
                    airports[name] = (area, feature)
            else:
                output.append(feature)
    output.extend(feature for area, feature in airports.values())
    seen = set()
    unique = []
    for feature in output:
        key = (feature['properties']['kind'], feature['properties']['name'], tuple(feature['geometry']['coordinates']))
        if key not in seen:
            seen.add(key)
            unique.append(feature)
    unique.sort(key=lambda f: (f['properties']['rank'], f['properties']['kind'], f['properties']['name']))
    return unique, raw_counts


def main():
    city_path = ROOT / 'public/data/houston-city.json'
    city = shape(json.loads(city_path.read_text())['geometry'])
    context = city.buffer(.025).simplify(.0001, preserve_topology=True)
    extent = [round(n, 6) for n in context.bounds]
    print('Preparing official labels for', extent, flush=True)
    streets, road_raw_count, connected_count = prepare_streets(extent, context)
    print('Prepared streets', len(streets), 'from', road_raw_count, 'raw source segments', flush=True)
    landmarks, landmark_raw_counts = prepare_landmarks(extent, context)
    output_dir = ROOT / 'public/data'
    for filename, features in [('houston-streets.json', streets), ('houston-landmarks.json', landmarks)]:
        (output_dir / filename).write_text(compact({'type': 'FeatureCollection', 'bbox': extent, 'features': features}))
    for source_id, source in SOURCES.items():
        metadata = fetch(source['url'])
        source['vintageNotes'] = {'coh-parks': 'Layer description dates park boundaries to April 11, 2019; modification timestamps do not establish feature-by-feature currency.', 'coh-libraries': 'Layer description says updated August 2023; modification timestamps are recorded separately.', 'coh-airports': 'Source describes airport polygons in Harris County; not every regional airport is represented.', 'usgs-city-halls': 'USGS National Structures service advertises an October 2026 refresh; individual points may have other source dates.'}.get(source_id, 'Source layer modification timestamp is recorded; it is not a road condition or passability observation.')
        source['sourceLastEditUtc'] = datetime.fromtimestamp(metadata.get('editingInfo', {}).get('lastEditDate', 0) / 1000, timezone.utc).isoformat() if metadata.get('editingInfo', {}).get('lastEditDate') else None
        if source.get('itemId'):
            item = fetch('https://www.arcgis.com/sharing/rest/content/items/' + source['itemId'])
            source['itemUrl'] = 'https://www.arcgis.com/home/item.html?id=' + source['itemId']
            source['publicAccessVerified'] = item.get('access') == 'public'
            source['publisher'] = item.get('owner')
        source['terms'] = CITY_NOTICE if source_id.startswith('coh-') else 'USGS National Map data are public domain; retain attribution. Source point locations are reference context, not operational status.'
        source['licenseStatus'] = 'Public City GIS; no separate open-content license was asserted in the source item.' if source_id.startswith('coh-') else 'US public-domain federal geographic data'
    metadata = {
        'schemaVersion': 1, 'retrievedAt': datetime.now(timezone.utc).isoformat(), 'crs': 'EPSG:4326',
        'contextOnly': True, 'runtimeNetworkRequired': False, 'bbox': extent,
        'coverage': 'Full bundled Houston city geometry plus a 0.025-degree context margin (approximately 2.4–2.8 km; context boundary simplified within 0.0001 degrees), including detached city areas; outside context is discarded.',
        'cityBoundarySha256': hashlib.sha256(city_path.read_bytes()).hexdigest(),
        'streetCount': len(streets), 'streetCountsByRank': dict(Counter(str(f['properties']['rank']) for f in streets)),
        'streetRawSourceSegmentCount': road_raw_count, 'connectedStreetPathCount': connected_count,
        'streetProcessing': 'Named existing FREEWAY/HIGHWAY/TOLLWAY/MAJOR/MINOR/LOCAL centerlines; exact FULL_NAME retained, same-name/class connected paths merged then grouped by exact name/rank into MultiLineStrings, context clipped, simplified by 0.000015 degrees, coordinates rounded to six decimals. Tiny fragments under 18 m local or 8 m other omitted. No routing graph or closure/access claims.',
        'streetRank': {'0': 'FREEWAY, HIGHWAY, TOLLWAY', '1': 'MAJOR, MINOR', '2': 'LOCAL'},
        'landmarkCount': len(landmarks), 'landmarkCountsByKind': dict(Counter(f['properties']['kind'] for f in landmarks)),
        'landmarkRawSourceCounts': landmark_raw_counts,
        'landmarkProcessing': 'Source names preserved. Source point geometry retained; park/airport polygons become representative interior label points, not entrances. Duplicate airport runway/campus names use the largest source footprint once. Local public library and civic names are geographic context only.',
        'limitations': ['Snapshots of source geography; no current opening, condition, accessibility or emergency role is established.', 'Road labels do not establish passable roads or safe travel. Landmarks are not resource centers or shelter recommendations.', 'Selected landmark categories are not a complete catalogue of every place. City source accuracy/engineering/surveying disclaimer applies.', 'Source geometries are deliberately simplified for offline cartographic display; high zoom does not create survey precision.'],
        'sources': SOURCES,
    }
    (output_dir / 'houston-labels-meta.json').write_text(compact(metadata))
    print(compact({key: metadata[key] for key in ['streetCount', 'streetCountsByRank', 'landmarkCount', 'landmarkCountsByKind']}), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline', action='store_true', help='Require cached official responses; do not access the network')
    ARGS = parser.parse_args()
    main()
