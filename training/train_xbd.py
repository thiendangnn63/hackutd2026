"""Train a paired RGB EfficientNet-B0 from random weights. No downloads."""
from __future__ import annotations

import argparse
import json
import random
import shutil
import time
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
import torchvision
from PIL import Image
from torch import nn
from torch.utils.data import Dataset, DataLoader
from xbd_pipeline import CLASSES, IMAGE_SIZE, metrics_from_predictions, sha256, write_json


def make_model():
    model = torchvision.models.efficientnet_b0(weights=None)
    old = model.features[0][0]
    model.features[0][0] = nn.Conv2d(6, old.out_channels, old.kernel_size,
                                    old.stride, old.padding, bias=False)
    nn.init.kaiming_normal_(model.features[0][0].weight, mode="fan_out")
    model.classifier[1] = nn.Linear(model.classifier[1].in_features, len(CLASSES))
    return model


def read_pair(root, row, augment=False):
    crops = []
    for key in ("pre_image", "post_image"):
        path = (Path(root) / row[key]).resolve()
        if not path.is_relative_to(Path(root).resolve()):
            raise ValueError("Image path escapes data root")
        with Image.open(path) as image:
            image = image.convert("RGB").crop(row["box"]).resize((IMAGE_SIZE, IMAGE_SIZE), Image.Resampling.BILINEAR)
            crops.append(np.asarray(image, dtype=np.float32)/255.0)
    pair = np.concatenate(crops, axis=2)
    return pair_tensor(pair, augment)


def pair_tensor(pair, augment=False):
    if augment:
        # Identical transforms preserve the temporal pairing.
        pair = np.rot90(pair, random.randrange(4))
        if random.random() < 0.5:
            pair = np.flip(pair, axis=1)
    pair = ((pair-0.5)/0.5).transpose(2,0,1).copy()
    return torch.from_numpy(pair)


def cache_crops(root, rows, path):
    """Decode each large satellite image only once, cache compact uint8 crops."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    required = len(rows)*IMAGE_SIZE*IMAGE_SIZE*6
    if shutil.disk_usage(path.parent).free < required + 1024**3:
        raise RuntimeError(f"Insufficient temporary storage for {required/1024**3:.1f} GiB crop cache")
    cache = np.lib.format.open_memmap(path, mode="w+", dtype=np.uint8,
                                    shape=(len(rows), IMAGE_SIZE, IMAGE_SIZE, 6))
    tiles = defaultdict(list)
    for index,row in enumerate(rows):
        tiles[row["tile_id"]].append((index,row))
    lookup = {}
    for tile_number,(tile,group) in enumerate(tiles.items()):
        row = group[0][1]
        with Image.open(Path(root)/row["pre_image"]) as before, Image.open(Path(root)/row["post_image"]) as after:
            before, after = before.convert("RGB"), after.convert("RGB")
            for index,row in group:
                crops = [np.asarray(image.crop(row["box"]).resize((IMAGE_SIZE,IMAGE_SIZE),Image.Resampling.BILINEAR))
                         for image in (before, after)]
                cache[index] = np.concatenate(crops,axis=2)
                lookup[(row["tile_id"],row["building_id"])] = index
        if tile_number % 25 == 0:
            print(json.dumps({"status":"preparing_crops", "tile":tile_number, "total_tiles":len(tiles)}), flush=True)
    cache.flush()
    del cache
    return lookup


class BuildingPairs(Dataset):
    def __init__(self, root, rows, augment=False, cache_path=None, lookup=None):
        self.root, self.rows, self.augment = root, rows, augment
        self.cache_path, self.lookup, self.cache = cache_path, lookup, None

    def __len__(self):
        return len(self.rows)

    def __getitem__(self, index):
        row = self.rows[index]
        if self.cache_path:
            if self.cache is None:
                self.cache = np.load(self.cache_path, mmap_mode="r")
            value = self.cache[self.lookup[(row["tile_id"],row["building_id"])]]
            return pair_tensor(value.astype(np.float32)/255.0, self.augment), row["label"]
        return read_pair(self.root, row, self.augment), row["label"]


def evaluate(model, loader, device):
    model.eval()
    labels, predictions, probabilities = [], [], []
    with torch.inference_mode():
        for features, target in loader:
            probs = torch.softmax(model(features.to(device)), dim=1).cpu()
            labels.extend(target.tolist())
            predictions.extend(probs.argmax(1).tolist())
            probabilities.extend(probs.tolist())
    return metrics_from_predictions(labels, predictions), probabilities


def train(args):
    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    torch.set_num_threads(min(4, torch.get_num_threads()))
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(args.seed)
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    if device.type != "cuda" and not args.allow_cpu:
        raise RuntimeError("No GPU visible. Select only an available free Kaggle GPU; do not purchase compute.")
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=True)
    if (output / "best.pt").exists():
        raise ValueError("Output already has a model. Use a new output directory; existing results are not overwritten.")
    manifest = json.loads(Path(args.manifest).read_text())
    if manifest["classes"] != CLASSES or manifest["split_unit"] != "source_tile":
        raise ValueError("Unexpected label order or split policy")
    split_rows = {part: [r for r in manifest["rows"] if r["split"] == part]
                  for part in ("train", "validation", "test")}
    tile_sets = {part: {r["tile_id"] for r in rows} for part, rows in split_rows.items()}
    for a,b in (("train","validation"),("train","test"),("validation","test")):
        if tile_sets[a] & tile_sets[b]:
            raise ValueError("Source-tile leakage detected")
    if any(not rows for rows in split_rows.values()):
        raise ValueError("Empty data split")
    write_json(output / "status.json", {"status":"preparing_crops"})
    lookup = cache_crops(args.data_root, manifest["rows"], args.crop_cache)
    loaders = {part: DataLoader(BuildingPairs(args.data_root, rows, part == "train", args.crop_cache, lookup),
                               batch_size=args.batch_size, shuffle=part == "train",
                               num_workers=args.workers, pin_memory=device.type == "cuda")
               for part, rows in split_rows.items()}
    counts = np.bincount([r["label"] for r in split_rows["train"]], minlength=4)
    if np.any(counts == 0):
        raise ValueError("Every damage class must occur in the training split")
    weights = counts.astype(float) ** -0.5
    weights /= weights.mean()
    model = make_model().to(device)
    loss_fn = nn.CrossEntropyLoss(weight=torch.tensor(weights, dtype=torch.float32, device=device))
    optimizer = torch.optim.AdamW(model.parameters(), lr=args.learning_rate, weight_decay=1e-4)
    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs)
    config = {"schema_version": 1, "architecture": "efficientnet_b0_6channel",
              "initialization": "random", "pretrained_weights": None,
              "classes": CLASSES, "image_size": IMAGE_SIZE,
              "channel_order": ["pre_R","pre_G","pre_B","post_R","post_G","post_B"],
              "normalization": {"mean": [0.5]*6, "std": [0.5]*6},
              "manifest_sha256": sha256(args.manifest), "seed": args.seed,
              "event": manifest["event"], "device": str(device),
              "torch_version": str(torch.__version__), "torchvision_version": str(torchvision.__version__),
              "hyperparameters": vars(args), "limitations": manifest["limitations"]}
    write_json(output / "model_config.json", config)
    write_json(output / "manifest.json", manifest)
    start, best_score, best_epoch, stale = time.monotonic(), -1.0, 0, 0
    history = []
    for epoch in range(1, args.epochs+1):
        model.train()
        running_loss, seen = 0.0, 0
        for batch_index, (features, target) in enumerate(loaders["train"]):
            optimizer.zero_grad(set_to_none=True)
            logits = model(features.to(device))
            loss = loss_fn(logits, target.to(device))
            if not torch.isfinite(loss):
                raise RuntimeError("Non-finite training loss")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 5.0)
            optimizer.step()
            seen += len(target)
            running_loss += loss.item()*len(target)
            if batch_index % 25 == 0:
                write_json(output / "status.json", {"status":"training", "epoch":epoch,
                           "batch":batch_index, "elapsed_seconds":time.monotonic()-start})
            if time.monotonic()-start > args.max_hours*3600:
                break
        val_metrics, _ = evaluate(model, loaders["validation"], device)
        record = {"epoch":epoch, "train_loss":running_loss/max(seen,1),
                  "validation":val_metrics, "elapsed_seconds":time.monotonic()-start}
        history.append(record)
        write_json(output / "history.json", history)
        print(json.dumps(record), flush=True)
        if val_metrics["macro_f1"] > best_score:
            best_score, best_epoch, stale = val_metrics["macro_f1"], epoch, 0
            torch.save({"state_dict": {k:v.detach().cpu() for k,v in model.state_dict().items()},
                        "epoch": epoch, "validation_macro_f1":best_score}, output / "best.pt")
        else:
            stale += 1
        scheduler.step()
        if stale >= args.patience or time.monotonic()-start > args.max_hours*3600:
            break
    checkpoint = torch.load(output / "best.pt", map_location=device, weights_only=True)
    model.load_state_dict(checkpoint["state_dict"])
    # Test is opened once, after selection by validation only.
    test_metrics, probabilities = evaluate(model, loaders["test"], device)
    final = {"best_epoch": best_epoch, "validation_macro_f1": best_score, "test": test_metrics,
             "elapsed_seconds": time.monotonic()-start, "completed_epochs":len(history),
             "majority_baseline_test": metrics_from_predictions(
                 [r["label"] for r in split_rows["test"]],
                 [int(counts.argmax())]*len(split_rows["test"]))}
    write_json(output / "metrics.json", final)
    predictions = []
    model_hash = sha256(output / "best.pt")
    for row, probs in zip(split_rows["test"], probabilities):
        predictions.append({"tile_id":row["tile_id"], "building_id":row["building_id"],
                            "box":row["box"], "damage_class":CLASSES[int(np.argmax(probs))],
                            "probabilities":dict(zip(CLASSES, probs)), "state":"estimated",
                            "source":"custom_model", "split":"test",
                            "reference_label":CLASSES[row["label"]],
                            "model_sha256":model_hash})
    write_json(output / "heldout_predictions.json", predictions)
    # Preserve three truly held-out image pairs for the demo, with attribution.
    demo_tiles = sorted(tile_sets["test"])[:3]
    demo_dir = output / "demo_images"
    demo_dir.mkdir(exist_ok=True)
    for tile in demo_tiles:
        row = next(row for row in split_rows["test"] if row["tile_id"] == tile)
        for key in ("pre_image", "post_image"):
            shutil.copyfile(Path(args.data_root) / row[key], demo_dir / Path(row[key]).name)
    write_json(output / "demo_tiles.json", demo_tiles)
    write_json(output / "attribution.json", {
        "dataset":"xBD / xView2", "authors":"Gupta et al.; DIU, CMU SEI and collaborators; Maxar imagery",
        "source":"https://www.kaggle.com/datasets/tunguz/xview2-challenge-dataset-train-and-test",
        "version":3, "license":"CC BY-NC-SA 4.0",
        "license_url":"https://creativecommons.org/licenses/by-nc-sa/4.0/",
        "paper":"https://arxiv.org/abs/1911.09296",
        "use":"Noncommercial hackathon research prototype; preserve attribution and applicable share-alike terms."})
    write_json(output / "status.json", {"status":"completed", "best_epoch":best_epoch,
               "elapsed_seconds":time.monotonic()-start, "model_sha256":model_hash})
    write_json(output / "checksums.json", {str(p.relative_to(output)):sha256(p) for p in output.rglob("*") if p.is_file() and p.name != "checksums.json"})
    print(json.dumps({"status":"completed", "output":str(output), **final}), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--output", default="/kaggle/working/xbd_model")
    parser.add_argument("--epochs", type=int, default=12)
    parser.add_argument("--batch-size", type=int, default=32)
    parser.add_argument("--learning-rate", type=float, default=1e-3)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--patience", type=int, default=4)
    parser.add_argument("--max-hours", type=float, default=2.0)
    parser.add_argument("--allow-cpu", action="store_true", help="For local smoke tests only")
    parser.add_argument("--crop-cache", default="/kaggle/temp/xbd_crops.npy")
    arguments = parser.parse_args()
    if min(arguments.epochs, arguments.batch_size, arguments.patience, arguments.max_hours) <= 0:
        parser.error("Training limits must be positive")
    try:
        train(arguments)
    except Exception as exc:
        write_json(Path(arguments.output) / "status.json", {"status":"failed", "error":str(exc)})
        raise
