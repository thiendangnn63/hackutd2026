"""Import a trusted project-produced Kaggle bundle, without executing archive code."""
import argparse
import hashlib
import json
import math
import shutil
import struct
import subprocess
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath

CLASSES = ['no-damage', 'minor-damage', 'major-damage', 'destroyed']
REQUIRED = ['best.pt', 'model_config.json', 'metrics.json', 'status.json', 'demo_tiles.json', 'heldout_predictions.json', 'attribution.json']
JSON_FILES = REQUIRED[1:] + ['checksums.json', 'history.json', 'manifest.json']

def sha256(data):
    return hashlib.sha256(data).hexdigest()

def check(condition, message):
    if not condition:
        raise ValueError(message)

def validate_probabilities(probs, damage_class):
    check(isinstance(probs, dict) and set(probs) == set(CLASSES), 'Invalid probability classes')
    check(all(type(probs[c]) in (int, float) and math.isfinite(probs[c]) and 0 <= probs[c] <= 1 for c in CLASSES), 'Invalid probabilities')
    check(abs(sum(probs.values())-1) < 0.001, 'Invalid probability sum')
    check(max(CLASSES,key=lambda c:probs[c]) == damage_class, 'Prediction class does not match scores')

def png_size(data):
    check(data[:8] == b'\x89PNG\r\n\x1a\n' and data[12:16] == b'IHDR', 'Expected PNG image')
    width, height = struct.unpack('>II', data[16:24])
    check(0 < width <= 8192 and 0 < height <= 8192, 'Image dimensions out of bounds')
    return width, height

def import_bundle(archive, root, expected_sha, verify_live=True):
    archive, root = Path(archive), Path(root)
    check(len(expected_sha) == 64 and all(c in '0123456789abcdef' for c in expected_sha), 'An expected SHA256 is required')
    check(archive.stat().st_size <= 300 * 1024**2, 'Bundle too large')
    check(sha256(archive.read_bytes()) == expected_sha, 'Bundle SHA256 mismatch')
    with zipfile.ZipFile(archive) as z:
        files = {}
        total = 0
        for entry in z.infolist():
            name = PurePosixPath(entry.filename)
            check(not name.is_absolute() and '..' not in name.parts and '\\' not in entry.filename, 'Unsafe archive path')
            check((entry.external_attr >> 16) & 0o170000 != 0o120000, 'Symlinks are not allowed')
            if entry.is_dir():
                continue
            check(entry.filename not in files, 'Duplicate archive entry')
            total += entry.file_size
            check(total <= 400 * 1024**2 and entry.file_size <= 200 * 1024**2, 'Expanded bundle too large')
            files[entry.filename] = z.read(entry)
    check('checksums.json' in files, 'Expected flat model bundle root with checksums.json')
    hashes = json.loads(files['checksums.json'])
    for name, digest in hashes.items():
        check(name in files and sha256(files[name]) == digest, 'Checksum mismatch: ' + name)
    for name in REQUIRED:
        check(name in hashes, 'Required artifact is not checksummed: ' + name)
    config = json.loads(files['model_config.json'])
    status = json.loads(files['status.json'])
    model_hash = sha256(files['best.pt'])
    check(config['architecture'] == 'efficientnet_b0_6channel' and config['classes'] == CLASSES and config['image_size'] == 224, 'Unsupported model contract')
    check(config['channel_order'] == ['pre_R','pre_G','pre_B','post_R','post_G','post_B'], 'Unexpected channel order')
    check(config['normalization'] == {'mean':[0.5]*6, 'std':[0.5]*6}, 'Unexpected normalization')
    check(config['initialization'] == 'random' and config['pretrained_weights'] is None, 'Expected from-scratch training')
    check(status['status'] == 'completed' and status['model_sha256'] == model_hash, 'Training is not verified completed')
    demo_ids = json.loads(files['demo_tiles.json'])
    check(isinstance(demo_ids, list) and 1 <= len(demo_ids) <= 10 and len(set(demo_ids)) == len(demo_ids), 'Invalid demo tiles')
    predictions = json.loads(files['heldout_predictions.json'])
    tiles = []
    copied = set(REQUIRED + ['checksums.json'] + [name for name in JSON_FILES if name in hashes])
    for tile_id in demo_ids:
        check(isinstance(tile_id, str) and all(c.isalnum() or c in '_-' for c in tile_id), 'Invalid tile ID')
        pre = 'demo_images/' + tile_id + '_pre_disaster.png'
        post = 'demo_images/' + tile_id + '_post_disaster.png'
        check(pre in hashes and post in hashes, 'Missing checksummed image pair')
        width, height = png_size(files[pre])
        check(png_size(files[post]) == (width, height), 'Unaligned pair dimensions')
        buildings = []
        for row in predictions:
            if row['tile_id'] != tile_id:
                continue
            check(row['split'] == 'test' and row['state'] == 'estimated' and row['source'] == 'custom_model', 'Expected held-out model estimates')
            check(row['model_sha256'] == model_hash and row['damage_class'] in CLASSES, 'Prediction provenance mismatch')
            probs = row['probabilities']
            validate_probabilities(probs, row['damage_class'])
            box = row['box']
            check(isinstance(box,list) and len(box)==4 and all(type(x) is int for x in box), 'Invalid building box')
            check(0 <= box[0] < box[2] <= width and 0 <= box[1] < box[3] <= height, 'Building box outside image')
            check(isinstance(row['building_id'], str) and 0 < len(row['building_id']) <= 200, 'Invalid building ID')
            # Deliberately omit reference_label from the application data contract.
            buildings.append({'id':row['building_id'], 'box':box, 'damageClass':row['damage_class'], 'probabilities':probs, 'source':'cached_model_output', 'state':'estimated'})
        check(0 < len(buildings) <= 10000 and len({b['id'] for b in buildings}) == len(buildings), 'Invalid or duplicate building predictions')
        tiles.append({'id':tile_id, 'width':width, 'height':height, 'preFile':pre, 'postFile':post, 'buildings':buildings})
        copied.update([pre,post])
    output = root / '.data/models' / model_hash
    output.parent.mkdir(parents=True,exist_ok=True)
    if not output.exists():
        staging = Path(tempfile.mkdtemp(prefix='model-import-',dir=output.parent))
        for name in copied:
            destination = staging / name
            destination.parent.mkdir(parents=True,exist_ok=True)
            destination.write_bytes(files[name])
        (staging/'app_index.json').write_text(json.dumps({'tiles':tiles}))
        staging.rename(output)
    else:
        for name in copied:
            check((output/name).is_file() and (output/name).read_bytes() == files[name], 'Existing model artifact changed: '+name)
        check(json.loads((output/'app_index.json').read_text()) == {'tiles':tiles}, 'Existing application index changed')
    verification = {'verified':False,'reason':'Local inference has not been verified.'}
    if verify_live:
        python = root/'.venv/bin/python'
        first = tiles[0]
        selected = first['buildings'][0]
        try:
            result = subprocess.run([str(python), str(root/'training/infer_xbd.py'), '--model-dir',str(output), '--data-root',str(output), '--pre-image',first['preFile'], '--post-image',first['postFile'], '--box',*[str(x) for x in selected['box']]],capture_output=True,text=True,timeout=90,check=True)
            actual = json.loads(result.stdout)
            check(actual['state']=='estimated' and actual['source']=='custom_model' and actual['calibrated'] is False, 'Unexpected inference provenance')
            validate_probabilities(actual['probabilities'], actual['damage_class'])
            delta = max(abs(actual['probabilities'][c]-selected['probabilities'][c]) for c in CLASSES)
            check(actual['damage_class']==selected['damageClass'] and actual['model_sha256']==model_hash and delta < 0.001, 'Local inference differs from held-out prediction')
            verification = {'verified':True,'tileId':first['id'],'buildingId':selected['id'],'damageClass':actual['damage_class'],'maxProbabilityDelta':delta,'modelSha256':model_hash,'verifiedAt':datetime.now(timezone.utc).isoformat()}
        except (OSError,ValueError,KeyError,TypeError,subprocess.SubprocessError) as error:
            verification = {'verified':False,'reason':'Local inference validation failed: '+type(error).__name__}
    (output/'local-verification.json').write_text(json.dumps(verification,indent=2))
    active = root/'.data/model-active.json'
    temporary = active.with_suffix('.tmp')
    temporary.write_text(json.dumps({'modelSha256':model_hash,'bundleSha256':expected_sha,'importedAt':datetime.now(timezone.utc).isoformat()},indent=2))
    temporary.replace(active)
    return {'modelSha256':model_hash,'tiles':len(tiles),'buildings':sum(len(t['buildings']) for t in tiles),'localVerification':verification}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('archive')
    parser.add_argument('--sha256',required=True)
    parser.add_argument('--skip-inference',action='store_true',help='Import cached estimates only; live inference stays disabled')
    args = parser.parse_args()
    print(json.dumps(import_bundle(args.archive,Path(__file__).resolve().parents[1],args.sha256,not args.skip_inference),indent=2))
