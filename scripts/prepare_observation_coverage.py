#!/usr/bin/env python3
"""Build a small offline observation mask from the bundled quantitative indices.

Encoded sample zero is no observation. Every nonzero sample is observed,
including negative and zero MNDWI values. Counts are exact within each native
pixel block; browser queries retain bounds on uncertainty at partial blocks.
No flood classification, source request, or water-image modification occurs.
"""
import argparse
import hashlib
import json
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'public' / 'data'
MANIFEST = DATA / 'houston-water-imagery.json'
OUTPUT = DATA / 'houston-observation-coverage.json'
BLOCK_SIZE = 16


def digest(content):
    return hashlib.sha256(content).hexdigest()


def prepare(verify_against=None):
    manifest_bytes = MANIFEST.read_bytes()
    manifest = json.loads(manifest_bytes)
    if verify_against:
        assert manifest_bytes == (verify_against / 'houston-water-imagery.json').read_bytes(), 'Source manifests differ'
    scenes = []
    for scene in manifest['scenes']:
        url = scene['indexUrl']
        assert url.startswith('/data/water/') and Path(url).name == url.rsplit('/', 1)[1]
        path = DATA / 'water' / Path(url).name
        content = path.read_bytes()
        if verify_against:
            assert digest(content) == digest((verify_against / 'water' / path.name).read_bytes()), path.name
        with Image.open(path) as image:
            assert image.size == (scene['width'], scene['height'])
            values = np.asarray(image)
            assert np.issubdtype(values.dtype, np.integer)
            assert int(values.min()) >= 0 and int(values.max()) <= 20001
            observed = (values > 0).astype(np.uint16)
        height, width = observed.shape
        counts = np.add.reduceat(
            np.add.reduceat(observed, np.arange(0, height, BLOCK_SIZE), axis=0),
            np.arange(0, width, BLOCK_SIZE), axis=1)
        known = int(observed.sum())
        assert int(counts.sum()) == known
        scenes.append({
            'id': scene['id'], 'date': scene['date'], 'bbox': scene['bbox'],
            'width': width, 'height': height,
            'columns': int(counts.shape[1]), 'rows': int(counts.shape[0]),
            'knownPixels': known, 'counts': counts.ravel().tolist(),
            'sourceIndexUrl': url, 'sourceIndexSha256': digest(content),
            'analysisResolutionMeters': scene['analysisResolutionMeters'],
        })
    return {
        'schemaVersion': 1, 'crs': 'EPSG:4326', 'blockSize': BLOCK_SIZE,
        'encoding': 'observed-pixel-counts',
        'maskRule': 'Quantitative index encoded sample > 0 is observed; encoded 0 is unavailable. This is not the MNDWI > 0 water threshold.',
        'coverageMethod': 'Exact native-pixel counts in 16x16 blocks, including smaller edge blocks. Partial-block viewport queries use area-weighted estimates with rigorous minimum/maximum coverage bounds. Outside extent is unavailable observation coverage.',
        'sourceManifestSha256': digest(manifest_bytes), 'scenes': scenes,
    }


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--offline-check', action='store_true', help='Verify the checked-in grid against every source index pixel without writing')
    parser.add_argument('--verify-against', type=Path, help='Require byte-identical inputs in another explicitly supplied public/data directory')
    args = parser.parse_args()
    result = prepare(args.verify_against)
    content = encoded(result)
    assert len(content) < 1_000_000, 'Observation metadata exceeds the bounded one-megabyte budget'
    if args.offline_check:
        assert OUTPUT.read_bytes() == content, 'Coverage data differs from source-pixel-derived counts'
        action = 'Verified'
    else:
        temporary = OUTPUT.with_suffix('.json.tmp')
        temporary.write_bytes(content)
        temporary.replace(OUTPUT)
        action = 'Prepared'
    print(f'{action} {len(result["scenes"])} exact source masks as {len(content):,} bytes of bounded observation counts.')
    for scene in result['scenes']:
        print(f'{scene["date"]}: {scene["knownPixels"]:,}/{scene["width"] * scene["height"]:,} observed pixels; {scene["columns"]}x{scene["rows"]} blocks.')


if __name__ == '__main__':
    main()
