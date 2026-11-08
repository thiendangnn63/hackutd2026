"""Offline paired MNDWI comparison; never building damage or a flood boundary.

Use the project's existing Pillow/NumPy environment. No network operations.
  python scripts/prepare_harvey_water_change.py
  python scripts/prepare_harvey_water_change.py --check
Staging can read --source-root PROJECT and write --output-root STAGE separately.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

BASELINE = '2017-08-15'
AFTER_DATES = ['2017-08-30', '2017-09-01']
CELL_SIZE = 64
FIELDS = ['column', 'row', 'pixelCount', 'pairedPixels', 'positivePixels',
          'sumDeltaUnits', 'sumPositiveDeltaUnits', 'waterLikeIncreasePixels',
          'sumWaterLikePositiveDeltaUnits']
RELATIVE_OUTPUT = Path('public/data/houston-water-change.json')


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def checked_indices(value):
    value = np.asarray(value)
    if value.ndim != 2 or value.dtype.kind not in 'iu' or value.size == 0:
        raise ValueError('Use a nonempty two-dimensional integer index grid.')
    if value.min() < 0 or value.max() > 20001:
        raise ValueError('Index samples must be zero (unknown) or 1..20001.')
    return value.astype(np.int32)


def aggregate(before, after, cell_size=CELL_SIZE):
    before, after = checked_indices(before), checked_indices(after)
    if before.shape != after.shape:
        raise ValueError('Before/after index grids must have identical dimensions.')
    if not isinstance(cell_size, int) or isinstance(cell_size, bool) or not 1 <= cell_size <= 256:
        raise ValueError('Use a bounded integer aggregation cell size.')
    height, width = before.shape
    cells = []
    sums = [0] * (len(FIELDS) - 2)
    for y in range(0, height, cell_size):
        for x in range(0, width, cell_size):
            pre = before[y:y + cell_size, x:x + cell_size]
            post = after[y:y + cell_size, x:x + cell_size]
            valid = (pre != 0) & (post != 0)
            count = int(valid.sum())
            if not count:
                continue  # Missing cells are unknown, never zero change/dry.
            delta = post[valid] - pre[valid]  # Signed, no uint16 underflow.
            positive = np.maximum(delta, 0)
            water_like = post[valid] > 10001  # After MNDWI > 0.
            stats = [int(pre.size), count, int((delta > 0).sum()),
                     int(delta.sum(dtype=np.int64)), int(positive.sum(dtype=np.int64)),
                     int((water_like & (delta >= 2000)).sum()),
                     int(positive[water_like].sum(dtype=np.int64))]
            cells.append([x // cell_size, y // cell_size, *stats])
            sums = [total + value for total, value in zip(sums, stats)]
    totals = dict(zip(FIELDS[2:], sums))
    # pixelCount above sums only nonempty cells; the true bounded-grid pixel
    # denominator must include entirely unavailable cells as well.
    totals['pixelCount'] = width * height
    totals['pairedFraction'] = round(totals['pairedPixels'] / (width * height), 9)
    totals['meanPositiveDelta'] = round(totals['sumPositiveDeltaUnits'] / totals['pairedPixels'] / 10000, 9) if totals['pairedPixels'] else None
    totals['nonemptyCells'] = len(cells)
    return cells, totals


def safe_asset(root, url):
    if not isinstance(url, str) or not url.startswith('/data/water/') or '?' in url or '#' in url:
        raise ValueError('Use an existing local quantitative water index asset.')
    root = Path(root).resolve()
    path = (root / 'public' / url.lstrip('/')).resolve()
    if not path.is_relative_to(root / 'public/data/water') or not path.is_file():
        raise ValueError('The required local quantitative index is unavailable.')
    return path


def prepare(source_root):
    source_root = Path(source_root).resolve()
    source_manifest = source_root / 'public/data/houston-water-imagery.json'
    metadata = json.loads(source_manifest.read_text())
    scenes = {item['date']: item for item in metadata['scenes']}
    required = [scenes[date] for date in [BASELINE, *AFTER_DATES]]
    baseline = required[0]
    contract = ['bbox', 'crs', 'width', 'height', 'analysisResolutionMeters']
    if baseline['crs'] != 'EPSG:4326' or any(any(item[key] != baseline[key] for key in contract) for item in required):
        raise ValueError('Comparison requires the exact same geographic display grid.')
    arrays, inputs = {}, []
    for item in required:
        path = safe_asset(source_root, item['indexUrl'])
        if digest(path) != item['indexSha256']:
            raise ValueError('Quantitative input checksum changed; review before rebuilding.')
        array = checked_indices(np.asarray(Image.open(path)))
        if array.shape != (item['height'], item['width']) or int((array != 0).sum()) != item['validPixels']:
            raise ValueError('Quantitative input dimensions or observation mask changed.')
        arrays[item['date']] = array
        # Preserve exact product/granule IDs, original band calibration and
        # transforms; these values are copied, not reconstructed or inferred.
        inputs.append({key: item[key] for key in ['id', 'date', 'acquiredAt', 'indexUrl', 'indexSha256', 'sources']})
    comparisons = []
    for date in AFTER_DATES:
        cells, totals = aggregate(arrays[BASELINE], arrays[date])
        comparisons.append(dict(id='harvey-change-' + date, beforeDate=BASELINE,
                                afterDate=date, beforeInputId=baseline['id'],
                                afterInputId=scenes[date]['id'], totals=totals, cells=cells))
    return {
        'schemaVersion': 1,
        'kind': 'paired_mndwi_change',
        'title': 'Satellite water-signal increase',
        'attribution': metadata['attribution'],
        'sourceManifest': {'url': '/data/houston-water-imagery.json', 'sha256': digest(source_manifest)},
        'documentation': metadata['documentation'],
        'grid': {'bbox': baseline['bbox'], 'crs': baseline['crs'], 'width': baseline['width'],
                 'height': baseline['height'], 'cellSize': CELL_SIZE,
                 'columns': (baseline['width'] + CELL_SIZE - 1) // CELL_SIZE,
                 'rows': (baseline['height'] + CELL_SIZE - 1) // CELL_SIZE,
                 'nativeResolutionMeters': baseline['analysisResolutionMeters']},
        'metric': 'mean_positive_mndwi_delta',
        'metricFormula': 'sumPositiveDeltaUnits / pairedPixels / 10000; includes zero for observed non-increases.',
        'display': {'multiplier': 100, 'minimum': 0, 'maximum': 100,
                    'clampAboveMaximum': True, 'units': 'MNDWI difference × 100',
                    'maximumLabel': '100+', 'meaning': 'Water-signal increase, not damage severity.'},
        'cellFields': FIELDS,
        'encoding': {
            'input': metadata['indexEncoding'],
            'deltaUnit': 0.0001,
            'pairedPixels': 'Both dates have nonzero encoded samples; inherited cloud/shadow/no-data masks must pass on both dates.',
            'sumDeltaUnits': 'Sum(after sample − before sample) over jointly observed registered-grid pixels.',
            'sumPositiveDeltaUnits': 'Sum(max(after sample − before sample, 0)) over jointly observed registered-grid pixels.',
            'positivePixels': 'Count of jointly observed pixels with any positive MNDWI difference; no threshold.',
            'waterLikeIncreasePixels': 'Optional heuristic count: after MNDWI > 0 and after − before MNDWI ≥ 0.2. Not used for the primary color metric.',
            'sumWaterLikePositiveDeltaUnits': 'Optional sum of positive differences only where after MNDWI > 0; no minimum difference threshold.',
            'coverage': 'pairedPixels / pixelCount. Missing cells have zero paired pixels and are UNKNOWN, never zero change or dry ground.',
            'cellBounds': 'Use source pixel edges column*cellSize and row*cellSize, clamped to width/height, linearly mapped to bbox. Last cells are smaller.',
        },
        'heuristics': {'afterWaterLikeMndwiGreaterThan': 0, 'minimumIncreaseMndwi': 0.2,
                       'validatedFloodBoundary': False, 'usedForPrimaryMetric': False},
        'limitations': [
            'This is a numerical before/after spectral comparison, not a trained building-damage model, verified flood extent, damage severity or assistance estimate.',
            'Only jointly clear observations are compared. Missing/cloud-covered samples and areas outside the capture are unknown, never dry or unaffected.',
            'A 64×64 display-pixel cell summarizes its observed samples, not every location in the cell. It does not classify the entire cell as inundated.',
            '20 m native analysis is aggregated to roughly 1.3 km cells. Registered-grid sample counts are not independent native-sensor sample counts.',
            'Positive MNDWI change can include permanent water, wet surfaces, reflectance/seasonal differences, residual cloud effects and registration error. Thresholds are explicitly heuristic.',
            'This product does not establish personal safety, road access, shelter suitability, current conditions or reported assistance need.',
        ],
        'inputs': inputs,
        'comparisons': comparisons,
    }


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    default_root = Path(__file__).resolve().parents[1]
    parser.add_argument('--source-root', type=Path, default=default_root)
    parser.add_argument('--output-root', type=Path, default=default_root)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    result = prepare(args.source_root)
    content = encoded(result)
    output = args.output_root / RELATIVE_OUTPUT
    if args.check:
        if not output.is_file() or output.read_bytes() != content:
            raise ValueError('Prepared comparison differs from the checked-in artifact.')
    else:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_bytes(content)
    print(json.dumps({'bytes': len(content), 'sha256': hashlib.sha256(content).hexdigest(),
                      'comparisons': [{'id': item['id'], **item['totals']} for item in result['comparisons']]}))


if __name__ == '__main__':
    main()
