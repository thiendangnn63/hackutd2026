"""Offline regression checks for bundled official Houston geography.

Reads only checked-in public assets. No GIS requests, app mutations or model loads.
"""
import json
from pathlib import Path
import unittest

from PIL import Image
from shapely.geometry import Point, shape
from shapely.ops import unary_union


DATA = Path(__file__).resolve().parents[1] / 'public' / 'data'
AREA_TOLERANCE = 1e-12  # Square degrees: floating-point residue only.


class HoustonGeometryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.city_feature = json.loads((DATA / 'houston-city.json').read_text())
        cls.regions = json.loads((DATA / 'houston-neighborhoods.json').read_text())['features']
        cls.meta = json.loads((DATA / 'houston-geography-meta.json').read_text())
        cls.city = shape(cls.city_feature['geometry'])
        cls.geometries = [shape(feature['geometry']) for feature in cls.regions]
        cls.coverage = unary_union(cls.geometries)

    def test_region_inventory_and_stable_ids(self):
        self.assertEqual(len(self.regions), 89)
        official = [f for f in self.regions if f['properties']['kind'] == 'super-neighborhood']
        remainder = [f for f in self.regions if f['properties']['kind'] == 'coverage-remainder']
        self.assertEqual(len(official), 88)
        self.assertEqual([f['properties']['id'] for f in remainder], ['houston-coverage-remainder'])
        self.assertEqual({f['properties']['id'] for f in official},
                         {f'houston-sn-{number:02d}' for number in range(1, 89)})
        self.assertEqual(len({f['properties']['id'] for f in self.regions}), 89)
        for feature in self.regions:
            with self.subTest(region=feature['properties']['id']):
                self.assertEqual(feature['id'], feature['properties']['id'])
                self.assertTrue(feature['properties']['name'])

    def test_geometries_valid_nonempty_and_polygonal(self):
        for identifier, geometry in [('houston', self.city)] + [
                (f['properties']['id'], g) for f, g in zip(self.regions, self.geometries)]:
            with self.subTest(region=identifier):
                self.assertTrue(geometry.is_valid)
                self.assertFalse(geometry.is_empty)
                self.assertIn(geometry.geom_type, ('Polygon', 'MultiPolygon'))
                self.assertGreater(geometry.area, 0)

    def test_all_regions_stay_inside_city(self):
        self.assertLessEqual(self.coverage.difference(self.city).area, AREA_TOLERANCE)
        for feature, geometry in zip(self.regions, self.geometries):
            with self.subTest(region=feature['properties']['id']):
                self.assertLessEqual(geometry.difference(self.city).area, AREA_TOLERANCE)

    def test_every_city_area_has_coverage(self):
        self.assertLessEqual(self.city.difference(self.coverage).area, AREA_TOLERANCE)

    def test_region_interiors_do_not_overlap(self):
        # Union removes overlap; comparing areas detects duplicate coverage while
        # permitting shared edges, which have zero area.
        self.assertLessEqual(abs(sum(g.area for g in self.geometries) - self.coverage.area),
                             AREA_TOLERANCE)

    def test_independent_city_centers_excluded(self):
        # Representative town-center coordinates, not rectangular municipality masks.
        neighbors = {
            'Bellaire': (-95.4588, 29.7058),
            'West University Place': (-95.4338, 29.7180),
            'Katy': (-95.8244, 29.7858),
            'Pasadena': (-95.2091, 29.6911),
            'Sugar Land': (-95.6349, 29.6197),
            'Humble': (-95.2622, 29.9988),
        }
        for name, coordinates in neighbors.items():
            with self.subTest(city=name):
                point = Point(coordinates)
                self.assertFalse(self.city.covers(point))
                self.assertFalse(self.coverage.covers(point))

    def test_houston_inclusions_and_interior_labels(self):
        for name, coordinates in {
            'Downtown Houston': (-95.3698, 29.7604),
            'Kingwood': (-95.184, 30.05),
            'Clear Lake Houston': (-95.132, 29.578),
        }.items():
            with self.subTest(place=name):
                point = Point(coordinates)
                self.assertTrue(self.city.covers(point))
                self.assertTrue(self.coverage.covers(point))
        for feature, geometry in zip(self.regions, self.geometries):
            with self.subTest(label=feature['properties']['id']):
                self.assertTrue(geometry.covers(Point(feature['properties']['labelPoint'])))

    def test_imagery_extent_dimensions_and_historical_label(self):
        basemap = self.meta['basemap']
        self.assertTrue(basemap['available'])
        self.assertEqual(basemap['crs'], 'EPSG:4326')
        self.assertEqual(basemap['bbox'], self.meta['bbox'])
        self.assertEqual(basemap['bbox'], self.city_feature['bbox'])
        for actual, expected in zip(self.city.bounds, basemap['bbox']):
            self.assertAlmostEqual(actual, expected, places=12)
        self.assertEqual((basemap['width'], basemap['height']), (1200, 900))
        self.assertIn('historical', basemap['date'].lower())
        self.assertIn('capture date varies', basemap['date'].lower())
        image_path = DATA / basemap['file']
        self.assertEqual(image_path.resolve().parent, DATA.resolve())
        with Image.open(image_path) as image:
            self.assertEqual(image.format, 'JPEG')
            self.assertEqual(image.size, (1200, 900))
            image.load()  # Decode pixels, catching truncated/corrupt image files.


if __name__ == '__main__':
    unittest.main()
