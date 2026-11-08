"""One paired, pre-cropped building inference. Output JSON to stdout."""
import argparse
import json
from pathlib import Path

import torch
from xbd_pipeline import CLASSES, sha256
from train_xbd import make_model, read_pair


def infer(model_dir, root, pre_image, post_image, box):
    model_dir = Path(model_dir)
    config = json.loads((model_dir / "model_config.json").read_text())
    if config["classes"] != CLASSES or config["architecture"] != "efficientnet_b0_6channel":
        raise ValueError("Unsupported model contract")
    model = make_model()
    checkpoint = torch.load(model_dir / "best.pt", map_location="cpu", weights_only=True)
    model.load_state_dict(checkpoint["state_dict"])
    model.eval()
    with torch.inference_mode():
        row = {"pre_image":pre_image, "post_image":post_image, "box":box}
        probs = torch.softmax(model(read_pair(root, row)[None]), 1)[0].tolist()
    return {"damage_class":CLASSES[max(range(4), key=lambda i:probs[i])],
            "probabilities":dict(zip(CLASSES, probs)), "state":"estimated", "source":"custom_model",
            "model_sha256":sha256(model_dir / "best.pt"), "calibrated":False,
            "limitations":["Building-footprint crop classification only.",
                           "Not evidence of personal safety, road access or shelter suitability."]}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--pre-image", required=True)
    parser.add_argument("--post-image", required=True)
    parser.add_argument("--box", nargs=4, type=int, required=True)
    args = parser.parse_args()
    print(json.dumps(infer(args.model_dir, args.data_root, args.pre_image, args.post_image, args.box)))
