# Family Response · HackUTD 2026

A working **local, fictional disaster-response demo** for the grandparents inquiry story. A family member opens a contact concern, the app selects eligible community participants, a simulated SMS sighting becomes unverified evidence, and a demo officer records a verified outcome while any assistance request stays open.

**This is not an emergency service. Do not enter real personal, patient, or emergency information.** Nothing is sent to a phone, an AI provider, a public alert network, or a remote database. The interface labels simulated components throughout. The name is a working label.

## Run

The core app requires Node.js **22 or later** and has no JavaScript dependencies. Optional local satellite inference uses the Python dependencies listed below.

```sh
cp .env.example .env
npm start
```

Open **http://127.0.0.1:4173**. Use `npm run dev` for server restart on edits. Set `PORT` in `.env` if 4173 is busy. The server binds only to loopback; another device cannot connect.

```sh
npm run check
npm test
```

`check` validates JavaScript syntax and package JSON. `test` runs domain, persistence, and HTTP integration checks. No API keys or internet access are required for any check.

## Rehearse the grandparents story

1. Read the **simulated emergency alert**. Viewing it does not enroll anyone.
2. Open a family contact concern for fictional **Rosa and Miguel Santos**. The demo pre-fills their last-known tile, last contact, and description. Confirm permission to share the fictional description. The first new case is **C105**.
3. Send simulated outreach. Only opted-in contributors with a recently shared current location inside the selected tiles qualify. Stale locations, opted-out people, the family reporter, and outside-area participants are excluded. Repeated clicks do not duplicate inquiries.
4. In the SMS simulator, select C105 and `neighbor-1`, use an observation time before the scenario clock, and submit:
   > I saw Rosa and Miguel at Oak School. They need water for two people and the road is blocked.
5. Inspect separate sighting, water-need, and road-blockage observations. The family update explicitly says **unverified**. Safety remains unknown. This extraction uses a small scripted fixture parser, **not Nemotron**.
6. As the **demo officer**, select the sighting evidence, record an explicit fictional direct-confirmation basis, and choose the welfare outcome. For example: “During the exercise, Officer Rivera directly checked in with both Rosa and Miguel at Oak School and confirmed their identities and welfare.” This is a simulated officer decision, not real-world verification.
7. Stop the search after verification. The water task remains unassigned, and unanswered case **C104** remains open. A location, a welfare outcome, and a completed assistance task are different facts.
8. Try a correction, an unknown location, duplicate event ID, `STOP`, and the simulated extraction-failure option. Raw reports remain reviewable. Reset returns only this local exercise to its original fictional fixtures.

The scenario clock is fixed at **2026-11-07 14:30 UTC**. Observation and last-location times use that clock. Receipt/audit timestamps use the real machine clock. The UI map is schematic, not a geographic or emergency navigation map.

## Architecture

- `src/domain.js`: fixtures, validation, recipient policy, case transitions, deterministic commands, explicitly simulated extraction, and outbox.
- `src/store.js`: atomic local JSON persistence. A failed action does not partially mutate the state. File writes are restricted to owner access.
- `src/server.js`: local HTTP API and static app. Same-origin mutations, strict loopback Host validation, body limits, and restrictive browser security headers.
- `src/satellite.js`: historical evidence and tightly scoped optional local inference, independent of family cases.
- `scripts/import_model.py`: checksum-verified model import and local inference verification.
- `training/`: reproducible from-scratch Kaggle training, local inference, and training tests.
- `public/`: dependency-free responsive web UI.
- `test/`: executable behavior/security regression tests.
- `docs/API.md`: shared frontend/backend contract.
- `docs/INTEGRATIONS.md`: exact boundaries and future integration gates.

The local data file `.data/state.json` and `.env` are ignored by Git. The app does not read any key for an external service. Adding a key to `.env` cannot activate a send or inference call.

## What works versus what is pending

**Implemented:** local case intake; stored reports; scoped dry-run recipient selection; simulated SMS inquiry/acknowledgment/family updates; source/time-linked observations; duplicate suppression; opt-out; officer evidence review; separate assistance state; restart persistence; reset; and a browser console. An optional historical satellite panel supports verified model bundles, cached predictions, and local inference when checkpoint verification passes.

**Simulated:** emergency alert, every SMS, model extraction, all people/locations, and the officer identity. The extraction parser recognizes scripted examples and conservatively routes other input to review. It is not suitable for real incoming reports.

**Not integrated:** Photon provisioning or webhooks, real send/reply/delivery tests, Lightning/Nano Omni inference, arbitrary satellite or resident-photo uploads, real authentication/roles, secure photo uploads, retention policy, agency authorization, and production deployment. This milestone does not satisfy the live-SMS acceptance criterion yet. Satellite predictions are available only after a trusted trained bundle is imported locally.

## Before any real integration

Keep credentials in the git-ignored `.env`, never in chat, frontend files, a notebook, or a commit. Use `.env.example` as the template. Do not enter a key until the integration step needs it.

Live messaging needs the exact Photon product/API and number verified, secure webhook authentication, consented test recipients, message content/purpose, and an explicit total spending limit within available credits. Existing credits are not a guarantee of zero charges. Live model inference likewise needs account access, input restrictions, and cost approval confirmed. The offline demo will continue to work without them.

Do not expose this server publicly. Demo role selection is not authorization. Production requires authenticated users, case-scoped access controls, secure identifiers, protected storage, data minimization/retention, rate limiting, audit controls, and an approved incident/verification policy.

## Optional trained satellite model

The satellite panel is separate from the fictional family exercise. It uses historical Hurricane Harvey 2017 pre/post satellite pairs with known building boxes. It does not accept resident ground photos or affect welfare/assistance states. Missing bundles produce an honest unavailable state.

The first trained bundle has been verified locally, including actual checkpoint inference and browser operation. See [the model card](docs/MODEL_CARD.md) for provenance, held-out scores, weak-class limitations, and verification details. The bundle is not stored in Git.

`training/` contains the from-scratch EfficientNet-B0 pipeline and self-contained Kaggle notebook. The notebook is intended for a private Kaggle run within existing free quota. Local inference is optional and uses CPU only. To prepare it with an existing Python 3.12 installation:

```sh
uv venv --python python3.12 .venv
uv pip install --python .venv/bin/python --index-url https://pypi.org/simple -r training/requirements-local.txt
npm run test:training
npm run test:model-import
```

Import only a trusted project-produced bundle, using its separately verified SHA-256:

```sh
npm run import:model -- /absolute/path/utd_xbd_model.zip --sha256 VERIFIED_BUNDLE_SHA256
```

The importer checks archive paths, per-file checksums, completed training, model contract, held-out predictions, probabilities, and crop bounds. It stores weights/images under git-ignored `.data/models/`, without changing the family exercise. The app never executes Python code from the archive. The importer loads the checkpoint through the repository's reviewed inference code with `torch.load(weights_only=True)` and compares a real local prediction with cached held-out output. Live inference remains disabled if this verification fails. The browser can run another local inference on a selected bundled crop, with a one-job limit and timeout.

All results remain estimates. Scores are uncalibrated. The panel exposes held-out macro F1, per-class F1/support, and a majority baseline; do not conceal weak or absent-class results. Tile-disjoint data from a single event does not prove generalization. Reference labels are excluded from the displayed prediction contract. xBD imagery has CC BY-NC-SA 4.0 noncommercial/share-alike requirements; see training/README.md and bundle attribution.
