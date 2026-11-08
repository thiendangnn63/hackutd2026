# Satellite damage baseline: verified local integration

## Intended use

Noncommercial hackathon research/demo only. This model estimates a building-damage class from an aligned historical before/after satellite pair and a supplied building box. It does not detect buildings, interpret resident ground photos, locate people, verify welfare, or establish road access or shelter suitability. Every output is an uncalibrated estimate requiring independent review.

## Model and data

- Architecture: EfficientNet-B0, modified for six input channels, initialized randomly with no pretrained weights.
- Input: pre RGB followed by post RGB, cropped to the supplied box, resized to 224×224, scaled to [0,1], then normalized with mean/std 0.5 for every channel.
- Output order: no-damage, minor-damage, major-damage, destroyed.
- Data: Hurricane Harvey subset of xBD/xView2, Tunguz Kaggle mirror version 3.
- Split: complete source tiles assigned to train/validation/test, seed 42. No source-tile overlap. Tile-disjoint does not guarantee geographically disjoint imagery or establish cross-disaster performance.
- Run: 12 epochs; checkpoint selected by validation macro F1, best epoch 12.
- Training environment: Kaggle free T4, PyTorch 2.11.0+cu130, torchvision 0.26.0+cu130. Private notebook version 366773916.

## Held-out results

Validation macro F1: **0.5273**. Test set: **2,857 building crops**.

| Metric | Model | Training-majority baseline |
|---|---:|---:|
| Test macro F1 | 0.5154 | 0.1454 |
| Test accuracy | 0.7109 | 0.4099 |

| Class | Test F1 | Reference support |
|---|---:|---:|
| no-damage | 0.7925 | 1,171 |
| minor-damage | 0.1804 | 268 |
| major-damage | 0.7659 | 1,333 |
| destroyed | 0.3230 | 85 |

Minor-damage and destroyed performance is weak. The destroyed class has limited support. Overall accuracy must not conceal these limitations. Class scores are not calibrated probabilities of safety. This is not validated for operational emergency response or new disasters.

## Local verification on 2026-11-08 UTC

- Imported the trusted project-produced ZIP after verifying its separately supplied SHA-256 and all listed artifact checksums.
- Preserved reviewed inference source from the repository; no Python from the model ZIP was executed.
- Loaded the real checkpoint with `torch.load(weights_only=True)` on CPU and reproduced a held-out prediction. Maximum probability difference from the Kaggle output: **5.12e-9**.
- Browser inference used the real checkpoint and completed in **1,948 ms** for the tested crop. This is one local measurement, not a latency guarantee.
- Three held-out before/after image pairs and **218 known building crops** are available in the local panel. Cached and newly computed outputs are labeled separately; reference labels are excluded from the application prediction contract.
- The family exercise state was unchanged by import and inference.

Model SHA-256:
`78414e4f5076e02afcd65018ede5b78575b785df9398fce41301faac5c3fa329`

Bundle SHA-256:
`93a62ca7e895e29d51733a57bbe777837bfa27dfbea50d6b0e1b7248228dc1e4`

Manifest SHA-256:
`b394563b13c794fd28ff08ec5faf72d2fda52f393f67b51ea8867bdf110b829d`

Weights and historical imagery remain in git-ignored local storage. A fresh checkout has no model until its trusted bundle is imported using the README procedure. Local dependency versions are pinned in `training/requirements-local.txt`.

## Attribution and restrictions

xBD/xView2: Gupta et al.; DIU, CMU SEI and collaborators; Maxar imagery. Dataset mirror: <https://www.kaggle.com/datasets/tunguz/xview2-challenge-dataset-train-and-test>. Original paper: <https://arxiv.org/abs/1911.09296>.

Dataset license: **CC BY-NC-SA 4.0**, <https://creativecommons.org/licenses/by-nc-sa/4.0/>. Preserve attribution and applicable noncommercial/share-alike terms. This prototype does not grant commercial rights.
