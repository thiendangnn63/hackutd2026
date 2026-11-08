#!/usr/bin/env python3
"""Prepare fictional planning points against bundled NOAA imagery, offline.

Requires Pillow for reading existing source alpha. No geocoding, network, model,
or flood classification is performed. Coordinates/roles/capacities are invented
exercise fixtures; source pixels establish imagery coverage only.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

# Small visually inspected built patches, rather than the whole reservoirs or
# the neighborhood centroids. Jitter spreads invented reports across a few
# adjacent blocks; it does not claim reports from any actual resident/address.
CLUSTERS = [
    {"id": "supplies", "regionId": "houston-sn-17", "imageryId": "harvey-20170830-barker",
     "requestCount": 300, "categories": ["supplies"],
     "patches": [[-95.6361, 29.7618, -95.6347, 29.7633],
                 [-95.6371, 29.7577, -95.6357, 29.7591],
                 [-95.6341, 29.7558, -95.6328, 29.7571]]},
    {"id": "evacuation", "regionId": "houston-sn-43", "imageryId": "harvey-20170831-kingwood",
     "requestCount": 100, "categories": ["evacuation", "supplies"],
     "patches": [[-95.1835, 30.0394, -95.1820, 30.0407],
                 [-95.1810, 30.0371, -95.1796, 30.0385],
                 [-95.1782, 30.0340, -95.1768, 30.0354]]},
    {"id": "medical", "regionId": "houston-sn-09", "imageryId": "harvey-20170830-addicks",
     "requestCount": 2, "categories": ["medical"],
     "patches": [[-95.6738, 29.7864, -95.6725, 29.7874],
                 [-95.6618, 29.7893, -95.6608, 29.7901]]},
]

FACILITIES = [
    {"id": "facility-0", "type": "supplies", "name": "Barker demo supply point", "resource": "Water & essential supplies", "capacity": "240 kits", "regionId": "houston-sn-17", "point": [-95.6402, 29.7568], "imageryId": "harvey-20170830-barker"},
    {"id": "facility-1", "type": "shelter", "name": "Barker demo shelter", "resource": "Temporary hospitality", "capacity": "120 people", "regionId": "houston-sn-17", "point": [-95.6324, 29.7596], "imageryId": "harvey-20170830-barker"},
    {"id": "facility-2", "type": "medical", "name": "Kingwood demo medical point", "resource": "Medical assessment", "capacity": "24 stations", "regionId": "houston-sn-43", "point": [-95.1732, 30.0354], "imageryId": "harvey-20170831-kingwood"},
    {"id": "facility-3", "type": "supplies", "name": "Park Ten demo supply point", "resource": "Food & essential supplies", "capacity": "180 kits", "regionId": "houston-sn-09", "point": [-95.6731, 29.7869], "imageryId": "harvey-20170830-addicks"},
    {"id": "facility-4", "type": "shelter", "name": "Kingwood demo shelter", "resource": "Temporary hospitality", "capacity": "90 people", "regionId": "houston-sn-43", "point": [-95.1768, 30.0417], "imageryId": "harvey-20170831-kingwood"},
    {"id": "facility-5", "type": "medical", "name": "Park Ten demo medical point", "resource": "Medical assessment", "capacity": "12 stations", "regionId": "houston-sn-09", "point": [-95.6613, 29.7898], "imageryId": "harvey-20170830-addicks"},
]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def in_ring(point, ring):
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:] + ring[:1]):
        if (a[1] > y) != (b[1] > y) and x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]:
            inside = not inside
    return inside


def contains(point, geometry):
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    return any(in_ring(point, polygon[0]) and not any(in_ring(point, hole) for hole in polygon[1:]) for polygon in polygons)


def halton(number, base):
    result, fraction = 0.0, 1.0
    while number:
        fraction /= base
        result += fraction * (number % base)
        number //= base
    return result


def prepare(source_root):
    data = source_root / "public/data"
    city_file, regions_file, imagery_file = [data / name for name in ["houston-city.json", "houston-neighborhoods.json", "houston-flood-imagery.json"]]
    city = json.loads(city_file.read_text())["geometry"]
    regions = {item["properties"]["id"]: item for item in json.loads(regions_file.read_text())["features"]}
    raw = json.loads(imagery_file.read_text())
    images = {image["id"]: image for scene in raw["imagery"] for image in scene["detail"]}
    opened = {}
    source_images = []
    for image_id in dict.fromkeys(cluster["imageryId"] for cluster in CLUSTERS):
        image = images[image_id]
        path = data / "flood-imagery" / image["file"]
        if digest(path) != image["sha256"]:
            raise ValueError(f"Source image checksum mismatch: {image_id}")
        pixels = Image.open(path)
        if pixels.size != (image["width"], image["height"]):
            raise ValueError(f"Source image dimensions mismatch: {image_id}")
        opened[image_id] = pixels.convert("RGBA").getchannel("A")
        source_images.append({key: image[key] for key in ["id", "date", "bbox", "width", "height", "sourceMetersPerPixel", "sha256"]})

    def valid(point, region_id, image_id):
        if not contains(point, city) or not contains(point, regions[region_id]["geometry"]):
            return False
        image = images[image_id]
        west, south, east, north = image["bbox"]
        lon, lat = point
        if not west < lon < east or not south < lat < north:
            return False
        x = math.floor((lon - west) / (east - west) * image["width"])
        y = math.floor((north - lat) / (north - south) * image["height"])
        alpha = opened[image_id]
        # A small margin also avoids no-data boundaries and interpolation edges.
        box = (x - 2, y - 2, x + 3, y + 3)
        return box[0] >= 0 and box[1] >= 0 and box[2] <= alpha.width and box[3] <= alpha.height and alpha.crop(box).getextrema() == (255, 255)

    clusters = []
    for definition in CLUSTERS:
        points = []
        for number in range(1, 20_001):
            west, south, east, north = definition["patches"][(number - 1) % len(definition["patches"])]
            point = [round(west + halton(number, 2) * (east - west), 7), round(south + halton(number, 3) * (north - south), 7)]
            if valid(point, definition["regionId"], definition["imageryId"]):
                points.append(point)
                if len(points) == definition["requestCount"]:
                    break
        if len(points) != definition["requestCount"]:
            raise ValueError(f"Not enough covered points: {definition['id']}")
        image = images[definition["imageryId"]]
        clusters.append({key: definition[key] for key in ["id", "regionId", "imageryId", "requestCount", "categories"]} | {
            "regionName": regions[definition["regionId"]]["properties"]["name"], "imageryDate": image["date"],
            "locationSource": "fictional-fixture", "samplingBounds": definition["patches"], "points": points,
        })

    facilities = []
    for definition in FACILITIES:
        if not valid(definition["point"], definition["regionId"], definition["imageryId"]):
            raise ValueError(f"Facility is not inside its city/region/opaque image: {definition['id']}")
        facilities.append(definition | {"imageryDate": images[definition["imageryId"]]["date"], "locationSource": "fictional-fixture", "fictional": True, "operational": False})

    return {
        "schemaVersion": 1, "id": "houston-covered-planning-demo", "fictional": True, "crs": "EPSG:4326",
        "clusters": clusters, "facilities": facilities,
        "sourceImages": source_images,
        "validation": {"citySha256": digest(city_file), "regionsSha256": digest(regions_file), "imageryManifestSha256": digest(imagery_file),
                       "placedRequests": sum(cluster["requestCount"] for cluster in clusters), "facilities": len(facilities),
                       "method": "Every point inside official city and assigned region; actual bundled source alpha=255 throughout a 5x5 pixel neighborhood. Built patches selected by visual inspection; no flood/dry or operating-status classification."},
        "limitations": ["All reports, roles, facilities and capacities are fictional and nonoperational.",
                        "Historical NOAA imagery establishes geographic context and image coverage only; it does not establish actual reports, shelter suitability, safe access or current flood conditions.",
                        "The separate Oak District family welfare exercise and hospitality scoring are unchanged."],
        "generator": "scripts/prepare_houston_demo_placements.py",
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=ROOT / "public/data/houston-demo-placements.json")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    manifest = prepare(args.source_root)
    if args.check:
        if json.loads(args.output.read_text()) != manifest:
            raise ValueError("Prepared placement manifest differs from the deterministic verified result")
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Verified {manifest['validation']['placedRequests']} fictional request points and {len(manifest['facilities'])} facilities in covered Houston built patches.")


if __name__ == "__main__":
    main()
