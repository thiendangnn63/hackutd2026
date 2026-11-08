"""Network-free geometric/native-resolution checks for the prepared imagery pyramid."""
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import sys
import unittest
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from prepare_cached_imagery_pyramid import pixels,warp_bound,mercator
DATA=ROOT/'public/data'


class ImageryPyramidTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.manifest=json.loads((DATA/'houston-imagery-pyramid.json').read_text())
        cls.grid=json.loads((DATA/'houston-imagery-source.json').read_text())['tileInfo']

    def test_every_mesh_error_bound_is_below_five_hundredths_of_an_output_pixel(self):
        for tier in self.manifest['tiers']:
            level=13+tier['level']
            for tile in tier['tiles']:
                with self.subTest(tile=tile['id']):
                    self.assertLess(warp_bound(tile['bbox'],tile['height'],level,self.grid),.05)

    def test_source_cache_sampling_is_finer_than_destination_sampling_at_every_tier(self):
        for tier in self.manifest['tiers']:
            level=13+tier['level']
            res=next(l['resolution'] for l in self.grid['lods'] if l['level']==level)
            for tile in tier['tiles']:
                latitude=(tile['bbox'][1]+tile['bbox'][3])/2
                native=res*math.cos(math.radians(latitude))
                self.assertLess(native,tile['metersPerPixel'])

    def test_web_mercator_source_coordinates_match_the_official_cache_origin(self):
        level=16;res=next(l['resolution'] for l in self.grid['lods'] if l['level']==level)
        x,y=pixels(0,0,level,self.grid)
        self.assertAlmostEqual(x,-self.grid['origin']['x']/res,places=8)
        self.assertAlmostEqual(y,self.grid['origin']['y']/res,places=8)
        west,north=pixels(-95.5,30,level,self.grid);east,south=pixels(-95,29.5,level,self.grid)
        self.assertLess(west,east);self.assertLess(north,south)

    def test_available_assets_decode_with_matching_hashes_actual_bounds_and_cache_provenance(self):
        available=[t for tier in self.manifest['tiers'] for t in tier['tiles'] if t.get('available')]
        self.assertTrue(available,'At least one genuine detail tile must exist before claiming imagery is prepared')
        for tile in available:
            with self.subTest(tile=tile['id']):
                path=DATA/'imagery'/tile['file'];content=path.read_bytes()
                self.assertEqual(hashlib.sha256(content).hexdigest(),tile['sha256'])
                with Image.open(path) as image:
                    self.assertEqual(image.format,'WEBP');self.assertEqual(image.size,(tile['width'],tile['height']));image.load()
                self.assertIn('USGSImageryOnly',tile['sourceUrl']);self.assertLess(tile['warpErrorOutputPixelsBound'],.05)
                west,south,east,north=tile['bbox'];x0,y1=mercator(west,north);x1,y0=mercator(east,south)
                for key,value in [('xmin',x0),('ymin',y0),('xmax',x1),('ymax',y1)]:self.assertAlmostEqual(tile['sourceExtent'][key],value,places=6)
                self.assertLess(tile['sourceMetersPerPixel'],tile['metersPerPixel'])


if __name__=='__main__':unittest.main()
