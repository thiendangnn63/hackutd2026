"""Offline importer regressions. Fake weights are never deserialized or executed."""
import importlib.util
import json
from pathlib import Path
import struct
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import warnings
import zipfile

spec = importlib.util.spec_from_file_location('import_model', Path(__file__).resolve().parents[1] / 'scripts/import_model.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def encoded(value):
    return json.dumps(value).encode()


def fixture():
    weights = b'fictional-test-weight-bytes-not-a-real-model'
    model_hash = module.sha256(weights)
    # Only PNG headers are needed by the importer's dimension reader.
    png = b'\x89PNG\r\n\x1a\n' + struct.pack('>I', 13) + b'IHDR' + struct.pack('>II', 32, 24)
    row = dict(tile_id='test_tile', building_id='building-1', split='test', state='estimated', source='custom_model', model_sha256=model_hash, damage_class='minor-damage', reference_label='destroyed', box=[1, 2, 20, 22], probabilities=dict(zip(module.CLASSES, [.1, .7, .1, .1])))
    files = {'best.pt': weights, 'model_config.json': encoded(dict(architecture='efficientnet_b0_6channel', classes=module.CLASSES, image_size=224, channel_order=['pre_R','pre_G','pre_B','post_R','post_G','post_B'], normalization={'mean':[.5]*6,'std':[.5]*6}, initialization='random', pretrained_weights=None)), 'metrics.json': encoded({}), 'status.json': encoded({'status':'completed','model_sha256':model_hash}), 'demo_tiles.json': encoded(['test_tile']), 'heldout_predictions.json': encoded([row]), 'attribution.json': encoded({'fixture':True}), 'demo_images/test_tile_pre_disaster.png': png, 'demo_images/test_tile_post_disaster.png': png}
    return files


class ModelImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='satellite-import-test-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.root = self.base / 'app'
        self.files = fixture()

    def archive(self, mutate=None, extras=()):
        files = dict(self.files)
        hashes = {name:module.sha256(data) for name,data in files.items()}
        if mutate:
            mutate(files, hashes)
        files['checksums.json'] = encoded(hashes)
        path = self.base / 'bundle.zip'
        with warnings.catch_warnings():
            warnings.simplefilter('ignore', UserWarning)
            with zipfile.ZipFile(path, 'w') as archive:
                for name,data in files.items():
                    archive.writestr(name, data)
                for name,data in extras:
                    archive.writestr(name, data)
        return path, module.sha256(path.read_bytes())

    def run_import(self, **kwargs):
        path, digest = self.archive(**kwargs)
        return module.import_bundle(path, self.root, digest, verify_live=False)

    def test_valid_cached_import_separates_reference_and_disables_live(self):
        result = self.run_import()
        self.assertFalse(result['localVerification']['verified'])
        directory = self.root / '.data/models' / result['modelSha256']
        index = json.loads((directory / 'app_index.json').read_text())
        tile = index['tiles'][0]
        self.assertEqual((tile['width'], tile['height']), (32, 24))
        self.assertEqual(tile['preFile'], 'demo_images/test_tile_pre_disaster.png')
        self.assertEqual(tile['postFile'], 'demo_images/test_tile_post_disaster.png')
        building = tile['buildings'][0]
        self.assertEqual(building['damageClass'], 'minor-damage')
        self.assertEqual(building['box'], [1,2,20,22])
        self.assertEqual(building['probabilities']['minor-damage'], .7)
        self.assertNotIn('reference_label', json.dumps(index))
        self.assertEqual(building['state'], 'estimated')

    def inference_output(self):
        row = json.loads(self.files['heldout_predictions.json'])[0]
        return {key:row[key] for key in ['damage_class', 'probabilities', 'model_sha256', 'state', 'source']} | {'calibrated':False}

    def assert_cached_activation(self, result):
        directory = self.root / '.data/models' / result['modelSha256']
        active = json.loads((self.root / '.data/model-active.json').read_text())
        self.assertEqual(active['modelSha256'], result['modelSha256'])
        self.assertEqual(json.loads((directory / 'local-verification.json').read_text()), result['localVerification'])
        building = json.loads((directory / 'app_index.json').read_text())['tiles'][0]['buildings'][0]
        self.assertEqual(building['damageClass'], 'minor-damage')
        self.assertEqual(building['source'], 'cached_model_output')
        self.assertNotIn('reference_label', building)
        return directory

    def test_live_verification_matches_and_uses_only_local_script_fixed_argv(self):
        # A malicious archive script is deliberately ignored, never executed.
        path, digest = self.archive(extras=[('training/infer_xbd.py', b'raise RuntimeError("archive code must not run")')])
        with patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, json.dumps(self.inference_output()), '')) as run:
            result = module.import_bundle(path, self.root, digest, verify_live=True)
        verification = result['localVerification']
        self.assertTrue(verification['verified'])
        self.assertEqual(verification['tileId'], 'test_tile')
        self.assertEqual(verification['buildingId'], 'building-1')
        self.assertEqual(verification['damageClass'], 'minor-damage')
        self.assertEqual(verification['maxProbabilityDelta'], 0)
        directory = self.assert_cached_activation(result)
        run.assert_called_once_with([
            str(self.root / '.venv/bin/python'), str(self.root / 'training/infer_xbd.py'),
            '--model-dir', str(directory), '--data-root', str(directory),
            '--pre-image', 'demo_images/test_tile_pre_disaster.png',
            '--post-image', 'demo_images/test_tile_post_disaster.png',
            '--box', '1', '2', '20', '22',
        ], capture_output=True, text=True, timeout=90, check=True)
        self.assertFalse((directory / 'training/infer_xbd.py').exists())

    def test_live_malformed_or_mismatching_outputs_leave_cached_import_available(self):
        output = self.inference_output()
        malformed = ['invalid json', 'null', '[]', '{}']
        changes = [
            {'damage_class':'destroyed'}, {'model_sha256':'0'*64},
            {'state':'verified'}, {'source':'reference_label'}, {'calibrated':True},
            {'probabilities':{}}, {'probabilities':None},
            {'probabilities':dict.fromkeys(module.CLASSES, .25)},
            {'probabilities':output['probabilities'] | {'minor-damage':'0.7'}},
            {'probabilities':output['probabilities'] | {'destroyed':float('nan')}},
            {'probabilities':output['probabilities'] | {'destroyed':float('inf')}},
            {'probabilities':output['probabilities'] | {'destroyed':False}},
            {'probabilities':output['probabilities'] | {'unexpected':0}},
        ]
        malformed.extend(json.dumps(output | change) for change in changes)
        path, digest = self.archive()
        for stdout in malformed:
            with self.subTest(stdout=stdout), patch.object(module.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, stdout, 'private stderr')) as run:
                result = module.import_bundle(path, self.root, digest, verify_live=True)
                run.assert_called_once()
                self.assertFalse(result['localVerification']['verified'])
                self.assertNotIn('private stderr', result['localVerification']['reason'])
                self.assert_cached_activation(result)

    def test_live_process_failure_or_timeout_leave_cached_import_available(self):
        path, digest = self.archive()
        errors = [OSError('private missing interpreter path'), subprocess.CalledProcessError(1, ['fake'], stderr='private stderr'), subprocess.TimeoutExpired(['fake'], 90)]
        for error in errors:
            with self.subTest(error=type(error).__name__), patch.object(module.subprocess, 'run', side_effect=error) as run:
                result = module.import_bundle(path, self.root, digest, verify_live=True)
                run.assert_called_once()
                self.assertFalse(result['localVerification']['verified'])
                self.assertNotIn('private', result['localVerification']['reason'])
                self.assert_cached_activation(result)

    def test_reimport_rejects_tampered_artifacts_or_index(self):
        result = self.run_import()
        directory = self.root / '.data/models' / result['modelSha256']
        for name in ['model_config.json', 'demo_images/test_tile_pre_disaster.png', 'app_index.json']:
            path = directory / name
            original = path.read_bytes()
            path.write_bytes(b'altered fixture')
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.run_import()
            path.write_bytes(original)
        self.assertEqual(self.run_import()['modelSha256'], result['modelSha256'])

    def test_wrong_or_malformed_sha_never_activates(self):
        path, _ = self.archive()
        for digest in ['0'*64, '', 'G'*64]:
            with self.subTest(digest=digest), self.assertRaises(ValueError):
                module.import_bundle(path, self.root, digest, verify_live=False)
        self.assertFalse((self.root / '.data/model-active.json').exists())

    def test_unsafe_paths_duplicates_and_symlinks(self):
        symlink = zipfile.ZipInfo('link')
        symlink.create_system = 3
        symlink.external_attr = 0o120777 << 16
        for name in ['../escape', '/absolute', 'a\\escape', 'best.pt', symlink]:
            with self.subTest(name=str(name)), self.assertRaises(ValueError):
                self.run_import(extras=[(name,b'bad')])
        self.assertFalse((self.root / '.data/model-active.json').exists())

    def test_missing_and_incorrect_checksums(self):
        changes = [lambda f,h: h.pop('best.pt'), lambda f,h: h.pop('demo_images/test_tile_pre_disaster.png'), lambda f,h: h.update({'best.pt':'0'*64}), lambda f,h: f.pop('status.json')]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.run_import(mutate=change)

    def test_invalid_predictions_are_rejected(self):
        changes = [{'box':[-1,0,2,2]}, {'box':[0,0,33,24]}, {'probabilities':dict.fromkeys(module.CLASSES,.5)}, {'damage_class':'destroyed'}, {'split':'train'}, {'source':'reference_label'}, {'model_sha256':'0'*64}]
        for change in changes:
            def mutate(files, hashes):
                rows = json.loads(files['heldout_predictions.json'])
                rows[0].update(change)
                files['heldout_predictions.json'] = encoded(rows)
                hashes['heldout_predictions.json'] = module.sha256(files['heldout_predictions.json'])
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.run_import(mutate=mutate)


if __name__ == '__main__':
    unittest.main()
