#!/usr/bin/env python3
"""Validate bundled geographic context labels without network or API credentials."""
from collections import Counter
import json
import math
from pathlib import Path
from shapely.geometry import shape
from shapely.prepared import prep
from shapely.strtree import STRtree

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public/data'
streets = json.loads((DATA / 'houston-streets.json').read_text())
landmarks = json.loads((DATA / 'houston-landmarks.json').read_text())
meta = json.loads((DATA / 'houston-labels-meta.json').read_text())
city = shape(json.loads((DATA / 'houston-city.json').read_text())['geometry'])
context = prep(city.buffer(.0252))  # context-boundary simplification plus output rounding tolerance
assert streets['type'] == landmarks['type'] == 'FeatureCollection'
assert meta['crs'] == 'EPSG:4326' and meta['contextOnly'] and not meta['runtimeNetworkRequired']
assert len(streets['features']) == meta['streetCount']
assert len(landmarks['features']) == meta['landmarkCount']
assert len({(f['properties']['name'], f['properties']['rank']) for f in streets['features']}) == len(streets['features'])
assert all(source['url'].startswith('https://') for source in meta['sources'].values())
assert all(source.get('publicAccessVerified') for key, source in meta['sources'].items() if key.startswith('coh-'))

geometries = []
vertices = paths = 0
for feature in streets['features']:
    props, geometry = feature['properties'], feature['geometry']
    assert isinstance(props['name'], str) and props['name'].strip()
    assert props['rank'] in [0, 1, 2]
    assert geometry['type'] in ['LineString', 'MultiLineString']
    lines = [geometry['coordinates']] if geometry['type'] == 'LineString' else geometry['coordinates']
    paths += len(lines)
    for line in lines:
        assert len(line) >= 2 and len({tuple(p) for p in line}) >= 2
        assert all(len(p) == 2 and all(math.isfinite(v) for v in p) and -96 < p[0] < -94.9 and 29.4 < p[1] < 30.2 for p in line)
        vertices += len(line)
    spatial = shape(geometry)
    assert not spatial.is_empty and spatial.is_valid and context.covers(spatial), props['name']
    geometries.append(spatial)
assert paths == meta['connectedStreetPathCount']
for feature in landmarks['features']:
    props, geometry = feature['properties'], feature['geometry']
    assert geometry['type'] == 'Point' and len(geometry['coordinates']) == 2
    assert props['name'].strip() and props['kind'] in ['park', 'airport', 'library', 'civic']
    assert props['rank'] in [0, 1, 2] and props['contextOnly'] is True
    assert props['positionMethod'] in ['source_point', 'interior_label_point_from_source_polygon']
    assert context.covers(shape(geometry)), props['name']

# The outer city areas must not silently lose label coverage.
tree = STRtree(geometries)
regions = json.loads((DATA / 'houston-neighborhoods.json').read_text())['features']
coverage = {}
for feature in regions:
    name = feature['properties']['name']
    if name in ['Willowbrook', 'Eldridge / West Oaks', 'Westchase', 'Kingwood Area', 'Clear Lake']:
        count = len(tree.query(shape(feature['geometry']), predicate='intersects'))
        assert count > 0, name
        coverage[name] = count
assert len(coverage) == 5
print(json.dumps({'streetFeatures': len(geometries), 'connectedStreetPaths': paths, 'vertices': vertices,
                  'streetRanks': dict(Counter(f['properties']['rank'] for f in streets['features'])),
                  'landmarks': len(landmarks['features']), 'landmarkKinds': dict(Counter(f['properties']['kind'] for f in landmarks['features'])),
                  'neighborhoodStreetCoverage': coverage}, sort_keys=True))
