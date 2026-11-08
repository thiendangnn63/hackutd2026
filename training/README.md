# UTD satellite damage training

## Scope
A randomly initialized EfficientNet-B0 classifies known building-footprint crops from paired pre/post RGB satellite images. All parameters start from random values (`weights=None`); this is not fine-tuning. It is not a building detector, a person detector, or a system for establishing safety, access, or shelter suitability.

Dataset: [xBD/xView2, Tunguz Kaggle mirror](https://www.kaggle.com/datasets/tunguz/xview2-challenge-dataset-train-and-test), version 3, approximately 11.1 GB. [Original paper](https://arxiv.org/abs/1911.09296). Attribution: Gupta et al.; DIU, CMU SEI and collaborators; Maxar imagery. Dataset license: [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/). Noncommercial use only, with attribution and applicable share-alike terms. This does not grant commercial rights.

## Kaggle setup
- Keep the notebook private. Attach the dataset with Add Input.
- Use available free GPU quota only, with Internet off. Do not buy quota, link a new paid subscription, or generate API tokens.
- `utd_xbd_from_scratch.ipynb` embeds all source code. Its first cell checks the GPU and prepares the actual Harvey manifest. The second trains and exports the model bundle.
- Save & Run All creates a durable background run. Check the Logs and Output tabs. `status.json` distinguishes preparing_crops, training, completed and failed.
- Defaults: seed 42, 224px, batch 32, AdamW 0.001, 12 epochs, early stopping patience 4, approximately two-hour training-loop cap (preprocessing/evaluation adds time). Two T4s may be allocated by Kaggle; this small baseline uses one GPU.
- Training, validation and test split by complete source tile, 70/15/15 approximately. Demo imagery comes only from the held-out test split. Challenge test images lacking labels are not used as supervised evaluation data.
- Tile-disjoint does not guarantee geographically disjoint source scenes. This single-event experiment must not be presented as evidence of unseen-disaster generalization.
- Crop preparation decodes each tile once and uses a temporary uint8 memory-mapped cache, keeping huge raw image copies out of saved outputs.

## Outputs and integration
`utd_xbd_model.zip` includes best.pt, model_config.json, manifest.json, metrics.json, history.json, status.json, checksums.json, attribution.json, heldout_predictions.json, three held-out pre/post demo image pairs and Python inference source.

The model contract is six channels in this order: pre R/G/B, then post R/G/B; image size 224x224; values scaled from uint8 to [0,1], then (x-0.5)/0.5. Output label order is no-damage, minor-damage, major-damage, destroyed. Softmax values are uncalibrated. A crop box must come from a known footprint or a separate localization process, not from this classifier.

Run `infer_xbd.py --model-dir <bundle> --data-root <images> --pre-image <relative PNG> --post-image <relative PNG> --box x0 y0 x1 y1`. It emits JSON with damage_class, probabilities, state=estimated, source=custom_model, model_sha256 and limitations. Only load trusted project-produced checkpoint files, using torch.load(weights_only=True).

Keep reference_label separate from inference results. Do not place reference labels into model inputs. Validate checksums before integration; verify per-class support and F1, macro F1, and majority baseline before making quality claims. Show poor or absent-class performance honestly. Use the measured model as supporting evidence requiring human review, never automatic dispatch or welfare verification.

## Verification
Nine dependency-light unit tests cover split determinism, demo holdout, clipping, invalid geometry, metric edge cases and fixture preparation. A local synthetic end-to-end CPU smoke test covers random model initialization, one training epoch, held-out evaluation, checkpoint load, inference and export checksums. Synthetic scores are software tests, not model-quality evidence. Run on real Kaggle data is a separate verification step.

Dependencies: Python 3.10+, torch, torchvision, numpy, Pillow, shapely. Kaggle supplies these; local installation should use official registries. No credentials are embedded in these files.
