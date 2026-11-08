#!/usr/bin/env python3
"""Verify or reproduce the bundled historical context images using official source URLs.

Run after prepare_houston_geography.py, preserving the reviewed contextBasemaps
entries in houston-geography-meta.json. No app runtime invokes this downloader.
Use --offline-check for network-free size, format and checksum validation.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import urllib.parse
import urllib.request
from PIL import Image

DATA = Path(__file__).resolve().parents[1] / 'public' / 'data'
FILES = {'earth-context.jpg', 'houston-context.jpg', 'houston-metro.png'}
HOSTS = {'assets.science.nasa.gov', 'gibs.earthdata.nasa.gov', 'imagery.nationalmap.gov'}


def validate(image, content):
    with Image.open(io.BytesIO(content)) as raster:
        expected = 'PNG' if image['file'].endswith('.png') else 'JPEG'
        if raster.format != expected or raster.size != (image['width'], image['height']):
            raise ValueError(f"Unexpected raster dimensions or format: {image['file']}")
        raster.load()
    checksum = hashlib.sha256(content).hexdigest()
    if image.get('sha256') and checksum != image['sha256']:
        raise ValueError(f"Image checksum changed: {image['file']}; review the replacement before updating metadata")
    return checksum


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--offline-check', action='store_true')
    args = parser.parse_args()
    metadata = json.loads((DATA / 'houston-geography-meta.json').read_text())
    for image in metadata.get('contextBasemaps', []):
        if image['file'] not in FILES or image['crs'] != 'EPSG:4326':
            raise ValueError('Only reviewed local raster names and EPSG:4326 are supported')
        source = urllib.parse.urlparse(image['sourceUrl'])
        if source.scheme != 'https' or source.hostname not in HOSTS:
            raise ValueError('Source must be an official NASA or USGS HTTPS endpoint')
        destination = DATA / image['file']
        if destination.exists():
            content = destination.read_bytes()
        elif args.offline_check:
            raise FileNotFoundError(destination)
        else:
            with urllib.request.urlopen(image['sourceUrl'], timeout=60) as response:
                content = response.read(16 * 1024 * 1024 + 1)
            if len(content) > 16 * 1024 * 1024:
                raise ValueError('Unexpectedly large raster response')
            validate(image, content)
            destination.write_bytes(content)
        checksum = validate(image, content)
        print(f"Verified {image['file']} · {image['width']}×{image['height']} · {checksum[:12]} · {image['date']}")


if __name__ == '__main__':
    main()
