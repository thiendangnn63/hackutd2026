"""Small, reproducible xBD building-crop pipeline. No network or credentials."""
from __future__ import annotations

import hashlib
import json
import math
import random
from collections import Counter
from pathlib import Path

CLASSES = ["no-damage", "minor-damage", "major-damage", "destroyed"]
IMAGE_SIZE = 224


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False) + "\n")
    temporary.replace(path)


def crop_bounds(bounds, width, height, context=0.2):
    """Use the same square box for both registered images, clipped at edges."""
    x0, y0, x1, y1 = map(float, bounds)
    if not all(math.isfinite(x) for x in (x0, y0, x1, y1)):
        raise ValueError("Non-finite footprint bounds")
    if x1 <= x0 or y1 <= y0:
        raise ValueError("Empty footprint")
    side = max(x1 - x0, y1 - y0, 8) * (1 + 2 * context)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    result = [max(0, math.floor(cx-side/2)), max(0, math.floor(cy-side/2)),
              min(width, math.ceil(cx+side/2)), min(height, math.ceil(cy+side/2))]
    if result[2] <= result[0] or result[3] <= result[1]:
        raise ValueError("Footprint lies outside image")
    return result


def assign_splits(tile_ids, seed=42, demo_tiles=()):
    """Split complete source tiles before crops. Demo tiles only enter test."""
    tiles = sorted(set(tile_ids))
    held_out = set(demo_tiles)
    if not held_out <= set(tiles):
        raise ValueError(f"Unknown demo tiles: {sorted(held_out-set(tiles))}")
    candidates = sorted(set(tiles) - held_out)
    if len(candidates) < 12:
        raise ValueError("Need at least 12 non-demo source tiles for train/validation/test")
    random.Random(seed).shuffle(candidates)
    n_val = max(2, round(len(candidates) * 0.15))
    n_test = max(2, round(len(candidates) * 0.15))
    splits = {tile: "test" for tile in held_out}
    splits.update({tile: "validation" for tile in candidates[:n_val]})
    splits.update({tile: "test" for tile in candidates[n_val:n_val+n_test]})
    splits.update({tile: "train" for tile in candidates[n_val+n_test:]})
    return splits


def prepare(data_root, output, event="hurricane-harvey", seed=42, demo_tiles=()):
    from PIL import Image
    from shapely import wkt
    root, output = Path(data_root).resolve(), Path(output)
    label_files = sorted(root.rglob(f"{event}_*_post_disaster.json"))
    if not label_files:
        raise ValueError(f"No {event} post-disaster JSON labels under {root}. Attach xBD imagery AND original labels.")
    image_index = {}
    for image in sorted(root.rglob(f"{event}_*disaster.png")):
        if image.name in image_index:
            raise ValueError(f"Duplicate image basename: {image.name}; choose one dataset release")
        image_index[image.name] = image
    tile_labels = {}
    for path in label_files:
        tile = path.name.removesuffix("_post_disaster.json")
        if tile in tile_labels:
            raise ValueError(f"Duplicate label tile: {tile}; choose one dataset release")
        tile_labels[tile] = path
    split_map = assign_splits(tile_labels, seed, demo_tiles)
    rows, sources, skipped = [], [], Counter()
    for tile, label_path in tile_labels.items():
        pre_path = image_index.get(tile + "_pre_disaster.png")
        post_path = image_index.get(tile + "_post_disaster.png")
        if not pre_path or not post_path:
            raise ValueError(f"Missing before/after image for {tile}")
        with Image.open(pre_path) as pre, Image.open(post_path) as post:
            if pre.size != post.size:
                raise ValueError(f"Unaligned image dimensions for {tile}")
            width, height = pre.size
        data = json.loads(label_path.read_text())
        if not isinstance(data.get("features", {}).get("xy"), list):
            raise ValueError(f"Missing xBD pixel polygons: {label_path.name}")
        seen_ids = set()
        for index, feature in enumerate(data["features"]["xy"]):
            props = feature.get("properties", {})
            label = props.get("subtype")
            if label not in CLASSES:
                skipped[str(label)] += 1
                continue
            geom = wkt.loads(feature["wkt"])
            if geom.is_empty or not geom.is_valid or geom.geom_type not in ("Polygon", "MultiPolygon"):
                skipped["invalid_polygon"] += 1
                continue
            building = str(props.get("uid", index))
            if building in seen_ids:
                raise ValueError(f"Duplicate building ID in {tile}: {building}")
            seen_ids.add(building)
            rows.append({"tile_id": tile, "building_id": building,
                         "pre_image": str(pre_path.relative_to(root)),
                         "post_image": str(post_path.relative_to(root)),
                         "box": crop_bounds(geom.bounds, width, height),
                         "label": CLASSES.index(label), "split": split_map[tile]})
        sources.append({"tile_id": tile, "label_sha256": sha256(label_path),
                        "pre_sha256": sha256(pre_path), "post_sha256": sha256(post_path)})
    if not rows:
        raise ValueError("No classified building polygons found")
    counts = {part: dict(Counter(CLASSES[r["label"]] for r in rows if r["split"] == part))
              for part in ("train", "validation", "test")}
    if any(not counts[p] for p in counts):
        raise ValueError(f"One or more splits have no classified buildings: {counts}")
    missing = set(CLASSES) - set(counts["train"])
    if missing:
        raise ValueError(f"Training split lacks {sorted(missing)}. Choose a sufficiently representative dataset; do not silently relabel classes.")
    manifest = {"schema_version": 1, "event": event, "seed": seed, "classes": CLASSES,
                "image_size": IMAGE_SIZE, "split_unit": "source_tile", "rows": rows,
                "sources": sources, "counts": counts, "skipped": dict(skipped),
                "demo_tiles": sorted(demo_tiles),
                "limitations": ["Classification on supplied building footprints, not localization.",
                                "Tile-disjoint does not guarantee geographically disjoint scenes.",
                                "Single-event estimates do not establish cross-disaster performance."]}
    write_json(output, manifest)
    return manifest


def metrics_from_predictions(labels, predictions):
    """Fixed four-class macro F1, including zero-support classes explicitly."""
    if len(labels) != len(predictions) or not labels:
        raise ValueError("Metric inputs must be nonempty and equal length")
    matrix = [[0] * len(CLASSES) for _ in CLASSES]
    for actual, predicted in zip(labels, predictions):
        if actual not in range(4) or predicted not in range(4):
            raise ValueError("Class index out of range")
        matrix[actual][predicted] += 1
    per_class = {}
    for i, name in enumerate(CLASSES):
        tp, support = matrix[i][i], sum(matrix[i])
        predicted_count = sum(row[i] for row in matrix)
        precision = tp / predicted_count if predicted_count else 0.0
        recall = tp / support if support else 0.0
        f1 = 2*precision*recall/(precision+recall) if precision+recall else 0.0
        per_class[name] = {"precision": precision, "recall": recall, "f1": f1, "support": support}
    return {"macro_f1": sum(v["f1"] for v in per_class.values())/4,
            "accuracy": sum(matrix[i][i] for i in range(4))/len(labels),
            "per_class": per_class, "confusion_matrix": matrix,
            "absent_reference_classes": [k for k,v in per_class.items() if not v["support"]]}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--output", default="manifest.json")
    parser.add_argument("--event", default="hurricane-harvey")
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--demo-tiles", nargs="*", default=[])
    args = parser.parse_args()
    result = prepare(args.data_root, args.output, args.event, args.seed, args.demo_tiles)
    print(json.dumps({"buildings": len(result["rows"]), "tiles": len(result["sources"]),
                      "counts": result["counts"], "skipped": result["skipped"]}, indent=2))
