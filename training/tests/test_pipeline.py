import json
import tempfile
import unittest
from pathlib import Path
from PIL import Image
from xbd_pipeline import CLASSES, assign_splits, crop_bounds, metrics_from_predictions, prepare, sha256


def fixtures(root):
    images, labels = root / "train/images", root / "train/labels"
    images.mkdir(parents=True)
    labels.mkdir(parents=True)
    for tile_id in range(16):
        tile = f"hurricane-harvey_{tile_id:08d}"
        for period, color in (("pre", (30,60,90)), ("post", (100,50,20))):
            Image.new("RGB", (64,64), color).save(images / f"{tile}_{period}_disaster.png")
        features = [{"properties":{"uid":f"building-{i}", "subtype":label},
                     "wkt":f"POLYGON (({i*10+1} 1, {i*10+9} 1, {i*10+9} 9, {i*10+1} 9, {i*10+1} 1))"}
                    for i,label in enumerate(CLASSES)]
        (labels / f"{tile}_post_disaster.json").write_text(json.dumps({"features":{"xy":features}}))


class PipelineTests(unittest.TestCase):
    def test_split_repeatable_and_disjoint(self):
        tiles = [f"tile-{i}" for i in range(20)]
        first = assign_splits(tiles, demo_tiles=["tile-0"])
        self.assertEqual(first, assign_splits(reversed(tiles), demo_tiles=["tile-0"]))
        self.assertEqual(first["tile-0"], "test")
        self.assertEqual(set(first), set(tiles))
        self.assertEqual(set(first.values()), {"train","test","validation"})

    def test_small_split_rejected(self):
        with self.assertRaises(ValueError):
            assign_splits(["a","b"])

    def test_unknown_demo_rejected(self):
        with self.assertRaises(ValueError):
            assign_splits(range(20), demo_tiles=[99])

    def test_crop_clipped(self):
        self.assertEqual(crop_bounds([0,0,10,10], 64,64), [0,0,12,12])

    def test_invalid_crop(self):
        for box in ([0,0,0,1], [100,100,110,110], [0,0,float("nan"),10]):
            with self.assertRaises(ValueError):
                crop_bounds(box,64,64)

    def test_perfect_metrics(self):
        self.assertEqual(metrics_from_predictions([0,1,2,3],[0,1,2,3])["macro_f1"],1.0)

    def test_absent_class_reported(self):
        result = metrics_from_predictions([0,0],[0,0])
        self.assertEqual(result["macro_f1"],0.25)
        self.assertEqual(len(result["absent_reference_classes"]),3)

    def test_invalid_metrics(self):
        for a,b in (([],[]),([0],[0,1]),([4],[0])):
            with self.assertRaises(ValueError):
                metrics_from_predictions(a,b)

    def test_prepare_full_fixture(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            fixtures(root)
            target = root / "manifest.json"
            manifest = prepare(root, target)
            self.assertEqual(len(manifest["rows"]),64)
            self.assertEqual(len(manifest["sources"]),16)
            self.assertEqual(len(sha256(target)),64)
            for row in manifest["rows"]:
                self.assertFalse(Path(row["pre_image"]).is_absolute())
            for split, counts in manifest["counts"].items():
                self.assertEqual(set(counts), set(CLASSES))
            by_tile = {}
            for row in manifest["rows"]:
                by_tile.setdefault(row["tile_id"],set()).add(row["split"])
            self.assertTrue(all(len(x)==1 for x in by_tile.values()))


if __name__ == "__main__":
    unittest.main()
