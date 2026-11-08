"""Quantitative, offline checks for the registered before/after water signal."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('water_change', ROOT / 'scripts/prepare_harvey_water_change.py')
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class NumericComparison(unittest.TestCase):
    def test_signed_difference_unknown_intersection_and_zero_index_are_distinct(self):
        before = np.array([[1, 20001, 0], [10001, 5001, 9001]], dtype=np.uint16)
        after = np.array([[20001, 1, 10001], [10001, 10001, 8001]], dtype=np.uint16)
        cells, totals = MODULE.aggregate(before, after, 2)
        self.assertEqual(cells, [[0, 0, 4, 4, 2, 5000, 25000, 1, 20000],
                                 [1, 0, 2, 1, 0, -1000, 0, 0, 0]])
        self.assertEqual(totals['pixelCount'], 6)
        self.assertEqual(totals['pairedPixels'], 5)
        self.assertEqual(totals['sumDeltaUnits'], 4000)
        self.assertEqual(totals['sumPositiveDeltaUnits'], 25000)
        self.assertEqual(totals['meanPositiveDelta'], 0.5)
        self.assertEqual(totals['waterLikeIncreasePixels'], 1)
        # Encoded 10001 is an observed MNDWI zero, not the unknown sentinel.
        self.assertEqual(MODULE.aggregate([[10001]], [[10001]], 1)[1]['pairedPixels'], 1)

    def test_no_paired_observation_is_unknown_not_zero_change(self):
        cells, totals = MODULE.aggregate([[0, 10001]], [[10001, 0]], 1)
        self.assertEqual(cells, [])
        self.assertEqual(totals['pairedPixels'], 0)
        self.assertEqual(totals['pairedFraction'], 0)
        self.assertIsNone(totals['meanPositiveDelta'])

    def test_partial_edge_cells_preserve_exact_pixel_counts_and_order(self):
        before = np.full((65, 66), 10001, dtype=np.uint16)
        after = np.full((65, 66), 12001, dtype=np.uint16)
        cells, totals = MODULE.aggregate(before, after)
        self.assertEqual([row[:4] for row in cells], [[0, 0, 4096, 4096], [1, 0, 128, 128], [0, 1, 64, 64], [1, 1, 2, 2]])
        self.assertEqual(sum(row[2] for row in cells), 65 * 66)
        self.assertEqual(totals['meanPositiveDelta'], 0.2)
        self.assertEqual(totals['waterLikeIncreasePixels'], 65 * 66)

    def test_heuristic_count_is_separate_from_unthresholded_primary_metric(self):
        cells, totals = MODULE.aggregate([[9001, 9001, 11001]], [[10001, 10002, 11002]], 3)
        self.assertEqual(totals['positivePixels'], 3)
        self.assertEqual(totals['sumPositiveDeltaUnits'], 2002)
        self.assertEqual(totals['waterLikeIncreasePixels'], 0)
        self.assertGreater(totals['meanPositiveDelta'], 0)
        self.assertEqual(cells[0][-1], 1002)

    def test_malformed_or_differently_sized_grids_fail_without_silent_clamping(self):
        for before, after in [([[0]], [[0, 0]]), ([1, 2], [1, 2]), ([[20002]], [[1]]), ([[-1]], [[1]]), ([[1.5]], [[1]])]:
            with self.assertRaises(ValueError):
                MODULE.aggregate(before, after)
        for size in [0, 1.5, True, 257]:
            with self.assertRaises(ValueError):
                MODULE.aggregate([[1]], [[1]], size)

    def test_coarse_summaries_conserve_all_signed_and_positive_observations(self):
        before = np.arange(1, 36, dtype=np.uint16).reshape(5, 7) * 100
        after = np.flip(before, axis=1).copy()
        before[1, 1] = 0
        after[3, 4] = 0
        mask = (before != 0) & (after != 0)
        delta = after.astype(np.int32)[mask] - before.astype(np.int32)[mask]
        for size in [1, 2, 3, 64]:
            cells, totals = MODULE.aggregate(before, after, size)
            self.assertEqual(totals['pairedPixels'], int(mask.sum()))
            self.assertEqual(totals['sumDeltaUnits'], int(delta.sum()))
            self.assertEqual(totals['sumPositiveDeltaUnits'], int(np.maximum(delta, 0).sum()))
            self.assertEqual(sum(row[3] for row in cells), int(mask.sum()))


class PreparedAsset(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.asset = json.loads((ROOT / MODULE.RELATIVE_OUTPUT).read_text())
        cls.source = json.loads((ROOT / 'public/data/houston-water-imagery.json').read_text())

    def test_current_asset_rebuilds_byte_for_byte_without_network_or_rendered_images(self):
        expected = MODULE.encoded(MODULE.prepare(ROOT))
        self.assertEqual((ROOT / MODULE.RELATIVE_OUTPUT).read_bytes(), expected)
        self.assertEqual(self.asset['grid'], {'bbox': [-95.94, 29.48, -94.99, 30.14], 'crs': 'EPSG:4326', 'width': 4600, 'height': 3660, 'cellSize': 64, 'columns': 72, 'rows': 58, 'nativeResolutionMeters': 20})
        self.assertEqual(self.asset['metric'], 'mean_positive_mndwi_delta')
        self.assertFalse(self.asset['heuristics']['usedForPrimaryMetric'])
        self.assertFalse(self.asset['heuristics']['validatedFloodBoundary'])

    def test_every_total_matches_independent_full_grid_reduction_and_cloud_intersection(self):
        before = np.asarray(Image.open(ROOT / 'public/data/water/harvey-index-2017-08-15.png')).astype(np.int32)
        for comparison in self.asset['comparisons']:
            after = np.asarray(Image.open(ROOT / f"public/data/water/harvey-index-{comparison['afterDate']}.png")).astype(np.int32)
            mask = (before != 0) & (after != 0)
            delta = after[mask] - before[mask]
            totals = comparison['totals']
            self.assertEqual(totals['pairedPixels'], int(mask.sum()))
            self.assertEqual(totals['positivePixels'], int((delta > 0).sum()))
            self.assertEqual(totals['sumDeltaUnits'], int(delta.sum(dtype=np.int64)))
            self.assertEqual(totals['sumPositiveDeltaUnits'], int(np.maximum(delta, 0).sum(dtype=np.int64)))
            self.assertEqual(totals['waterLikeIncreasePixels'], int(((after[mask] > 10001) & (delta >= 2000)).sum()))
            self.assertEqual(totals['sumWaterLikePositiveDeltaUnits'], int(np.maximum(delta, 0)[after[mask] > 10001].sum(dtype=np.int64)))
            self.assertLess(totals['pairedPixels'], int((after != 0).sum()))
            self.assertTrue(all(0 < row[3] <= row[2] <= 4096 for row in comparison['cells']))
            self.assertEqual(len({(row[0], row[1]) for row in comparison['cells']}), len(comparison['cells']))

    def test_original_products_calibration_acquisition_and_numeric_hashes_are_preserved(self):
        self.assertEqual(self.asset['sourceManifest']['sha256'], MODULE.digest(ROOT / 'public/data/houston-water-imagery.json'))
        source = {item['id']: item for item in self.source['scenes']}
        for item in self.asset['inputs']:
            original = source[item['id']]
            for key in ['date', 'acquiredAt', 'indexUrl', 'indexSha256', 'sources']:
                self.assertEqual(item[key], original[key])
            self.assertEqual(MODULE.digest(ROOT / 'public' / item['indexUrl'].lstrip('/')), item['indexSha256'])
        self.assertEqual([item['beforeDate'] for item in self.asset['comparisons']], ['2017-08-15', '2017-08-15'])
        self.assertEqual([item['afterDate'] for item in self.asset['comparisons']], ['2017-08-30', '2017-09-01'])

    def test_external_or_missing_quantitative_assets_are_rejected(self):
        for url in ['https://example.test/index.png', '/data/water/../../secret', '/data/water/not-present.png', '/data/water/harvey-index-2017-08-15.png?other=1']:
            with self.assertRaises(ValueError):
                MODULE.safe_asset(ROOT, url)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'public/data').mkdir(parents=True)
            metadata = json.loads(json.dumps(self.source))
            metadata['scenes'][1]['width'] += 1
            (root / 'public/data/houston-water-imagery.json').write_text(json.dumps(metadata))
            with self.assertRaisesRegex(ValueError, 'same geographic display grid'):
                MODULE.prepare(root)


if __name__ == '__main__':
    unittest.main()
