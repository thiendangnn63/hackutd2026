# Beacon · HackUTD 2026

A working **local, fictional disaster-response demo** for the grandparents inquiry story. A family member opens a contact concern, the app selects eligible community participants, a simulated SMS sighting becomes unverified evidence, and a demo officer records a verified outcome while any assistance request stays open.

**This is not an emergency service. Do not enter real personal, patient, or emergency information.** Nothing is sent to a phone, an AI provider, a public alert network, or a remote database. The interface labels simulated components throughout.

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

## Map-first workspace

Open **http://127.0.0.1:4173/#mayor** for Beacon’s dark glass workspace. The original red/blue signal logo is a scalable vector at [`public/beacon-logo.svg`](public/beacon-logo.svg). The navigation rail switches between **Map**, **Messages**, **People**, **Casework**, and **Imagery**; it becomes bottom navigation on portrait phones; short landscape windows use a compact vertical rail. Messages and People use a list/detail flow on phones and short windows, with an explicit back button. Reading positions survive tab changes and local updates while the page remains open; a conversation follows new messages only when already reading its end. Longer person histories show a displayed/total count with Show all.

- Drag, scroll, pinch, or use the zoom controls. Neighborhoods reveal 2×2 subtiles at 2.2× zoom and 4×4 subtiles at 5×. Click or press Enter for on-map statistics. `+` / `−`, arrows, `0`, and Escape provide keyboard navigation. On mobile, **Overview** opens the layer and area panel. **Places** lists the fictional facilities; map search also finds facility names, resources, neighborhoods, named streets and geographic landmarks. **Filters** opens need categories, the demo scenario and facility types; its collapsed summary keeps active choices visible. On compact maps, Overview and Imagery open one at a time.
- **Assistance** uses red intensity for unique open requests, with medical / evacuation / supplies filters and an explicit numeric legend. **Hospitality** uses blue for fictional power/water/access planning scores. Hatching preserves unknown data in both modes. Scores are not approved shelter assessments. A fixed finest-level fixture set is aggregated by clipped land area, preserving known capacity and exposing partial/unknown coverage at every zoom level.
- Real street centerlines and geographic landmarks appear progressively as you zoom. Search accepts ordinary street types such as “Main Street” for the exact source label “MAIN ST.” Geographic references carry no access or operating-status assessment. Distribution, shelter, and medical markers have individual visibility filters and detail cards. Facility locations, resources, and capacities are fictional planning fixtures, not operating sites.
- **Imagery** opens dated Harvey 2017 views: a green/SWIR water-emphasis index, same-date Sentinel-2 true color, NOAA flood-response aerial photographs, and NASA/JPL’s Sentinel-1 radar flood proxy. A capture dropdown compares August 15 before Harvey with August 30 and September 1; NOAA has five acquisition days and sharp Addicks/Barker/Kingwood/San Jacinto examples, including native ~0.5 m Barker and Kingwood crops. The map starts with the cloud-penetrating radar proxy; **Show flooding** opens dated Barker street imagery directly. Water is cyan in the optical index; clouds, shadows and missing observations are dimmed unknown context, never dry ground. Water signal includes permanent water and does not establish a flood boundary, depth, access or assistance need. The optical analysis is 20 m; the radar proxy is 30 m and less reliable in urban areas. Reference aerial imagery is a separate option with four progressively loaded tiers down to about 2.8 m per output pixel. The reference pyramid also sharpens the context beneath dated observations. The camera supports closer street views up to 96×; the observation resolution remains explicit. Only visible local tiles load; normal app operation stays offline. Imagery and assistance overlay opacity remain independent. The Imagery tab provides a historical-pair dropdown and draggable before/after overlay for the three locally imported Harvey study areas. These pairs are not georeferenced to Houston; they are never overlaid on the city as if they were. The reference stack combines USGS/USDA 2017–2021 detail with wider aerial and NASA 2004 context. Those reference mosaics are not flood observations; use the explicitly dated event modes for historical comparisons.
- **Messages** combines actual local incoming reports and simulated outgoing messages into case conversations. **People** searches names, descriptions, last-known areas, and related message text, and shows raw evidence, observation/receipt times, welfare state, and officer review separately. Enter opens the selected person search result, including in compact views. Original inquiry text is labeled separately from the latest received report; source-message links open the exact message, including unassigned reports. Corrections, failed interpretations and opt-out commands remain distinct from sightings. Changes in Casework immediately update both tabs. Name matches rank above related-case matches; record and follow-up filters narrow the lists. Literal search terms are highlighted safely; Previous/Next and Enter/Shift+Enter locate matching messages, including older entries. Case-only matches are distinguished from message-content matches. Unassigned/orphan reports remain visible in their own review conversation. Opening a person’s conversation clears an unrelated message filter, and the message lab inherits the selected case. The Oak District case data remains separate from Houston's demonstration requests.

Historical water imagery may cross municipal boundaries; the current fictional request fixture and totals remain Houston-only. A broader incident coordination queue across jurisdictions is an accepted product direction, not an implemented provider workflow.

Optical imagery shows observation coverage for the current map view, excluding the open Overview panel and footer. A cloud-covered or missing observation is labeled unknown. A **Try Aug 30 / Sep 1** action appears only for a clearly better available response-date capture; clicking changes the date without panning. Dates never change automatically. Zero opacity, missing coverage metadata and failed source images have separate feedback and recovery actions.

Subtile report locations are deterministic synthetic fixtures inside the official neighborhood geometry. Every neighborhood total and overlapping need-category count is conserved at both detail levels. Empty cells and city holes remain clipped out. These coordinates are not real geocoded reports. For implementation details and verified behavior, see [UI workspace notes](docs/UI_WORKSPACE.md).

Casework has dedicated **Case review**, **New inquiry**, **Message lab**, and **Assistance** views. Successful intake and report submission return to the review queue, preserving the selected case.

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

The scenario clock is fixed at **2026-11-07 14:30 UTC**. Observation and last-location times use that clock. Receipt/audit timestamps use the real machine clock. The family exercise map is schematic, not a geographic or emergency navigation map.

## Rehearse the Houston mayor dashboard

Open **http://127.0.0.1:4173/#mayor**. This independent, read-only exercise uses real Houston geography and **fictional requests**, not live emergency data or the family exercise's reports.

- Full-purpose Houston city limits only, including interior holes and outlying Houston areas. The 88 official Super Neighborhoods are clipped to the city; an explicit 89th coverage area retains remaining city land. Neighboring cities are excluded.
- Bundled **historical USGS/USDA NAIP aerial imagery** and NASA Blue Marble satellite composites fill the geographic background. Surrounding towns may appear as context; request tiles and selection stay inside Houston. No image is a live disaster observation. Source attribution and limitations appear beneath the map; see [geographic provenance](docs/HOUSTON_DATA.md).
- Unique open requests set red opacity linearly: Willowbrook's 300 is 100%, Greater Greenspoint's 100 is 33.3%, and Carverdale's 2 is 0.7%. The legend keeps the same numeric range across subdivisions and filters. Multiple need categories do not duplicate the total request count.
- The map has no permanent count labels. Hover or focus a neighborhood for counts and categories; tap, click or Enter to zoom to it and show statistics in an on-map popover. Back to Houston, Fit Houston, or Escape returns to the whole city. Zoom buttons, wheel/pinch, drag panning, and keyboard +/−, arrows and 0 are supported; the fixed legend stays visible. Reported needs are reviewed medical → evacuation → supplies → other. This is a demo human-review preference, not clinical triage or dispatch.
- A separate coverage lane retains all 86 zero-report areas as **unknown**, not safe. The medical request in a quiet area remains visible as an individual urgent case. One unlocated request remains in human review, giving 403 total open requests versus 402 placed on the map.
- Choose **No reports · coverage check** to verify the zero-maximum case: no red overlay, all 89 areas still queued, no division by zero. Switching scenarios never writes or resets the family exercise.

The current dataset is a fixed demonstration, not live intake or location assignment. Source geography and historical imagery are bundled, so normal app operation makes no external map requests. Missing assets produce an explicit unavailable state rather than fabricated geography or imagery.

## Architecture

- `src/domain.js`: fixtures, validation, recipient policy, case transitions, deterministic commands, explicitly simulated extraction, and outbox.
- `src/store.js`: atomic local JSON persistence. A failed action does not partially mutate the state. File writes are restricted to owner access.
- `src/server.js`: local HTTP API and static app. Same-origin mutations, strict loopback Host validation, body limits, and restrictive browser security headers.
- `src/satellite.js`: historical evidence and tightly scoped optional local inference, independent of family cases.
- `src/houston.js` and `src/houston-service.js`: deduplicated open-request aggregation, coverage review, and the independent Houston fixture endpoint.
- `public/data/`, `scripts/prepare_houston_geography.py` and `scripts/prepare_context_imagery.py`: attributed official geography, historical raster context, and source preparation/verification.
- `scripts/import_model.py`: checksum-verified model import and local inference verification.
- `training/`: reproducible from-scratch Kaggle training, local inference, and training tests.
- `public/`: dependency-free responsive map workspace; `map-model.js` supplies geometry, fixture partitioning and camera gestures, `records.js` indexes existing case data, `workspace.js` handles tab views, `record-focus.js` preserves record focus, and `archive-view.js` handles image readiness and recovery.
- `test/`: executable behavior/security regression tests.
- `docs/API.md`: shared frontend/backend contract.
- `docs/INTEGRATIONS.md`: exact boundaries and future integration gates.

The local data file `.data/state.json` and `.env` are ignored by Git. The app does not read any key for an external service. Adding a key to `.env` cannot activate a send or inference call.

## What works versus what is pending

**Implemented:** local case intake; stored reports; scoped dry-run recipient selection; simulated SMS inquiry/acknowledgment/family updates; source/time-linked observations; duplicate suppression; opt-out; officer evidence review; separate assistance state; restart persistence; reset; and a browser console. The Houston-only mayor dashboard adds real geographic boundaries, historical aerial context, proportional fictional request counts, categories, and coverage/urgent review. An optional historical satellite panel supports verified model bundles, cached predictions, and local inference when checkpoint verification passes.

**Simulated:** emergency alert, every SMS, model extraction, all people/locations, and the officer identity. The extraction parser recognizes scripted examples and conservatively routes other input to review. It is not suitable for real incoming reports.

**Not integrated:** Photon provisioning or webhooks, real send/reply/delivery tests, Lightning/Nano Omni inference, arbitrary satellite or resident-photo uploads, real authentication/roles, secure photo uploads, retention policy, agency authorization, and production deployment. This milestone does not satisfy the live-SMS acceptance criterion yet. Satellite predictions are available only after a trusted trained bundle is imported locally.

The Houston dashboard does not yet ingest real reports, geocode addresses, update request status, or assign outreach. It does not overlay the historical Harvey classifier results onto current Houston boundaries: the bundled model crops do not provide a verified geographic placement contract.

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

## Optional geography regression checks

With the existing Python environment, install Shapely from the official PyPI registry if needed, then run `npm run test:geography`. These checks are network-free and verify the bundled city/region geometry, neighboring-city exclusions, and image extent. Shapely is a development check dependency only; the Node app does not need it.

With the existing Python environment, `.venv/bin/python scripts/prepare_context_imagery.py --offline-check` decodes the three context rasters and validates their recorded dimensions and SHA-256 checksums without network access.

For source methods, coverage, native sampling, numeric index encoding and offline verification commands, see [Houston imagery provenance](docs/HOUSTON_DATA.md). The checked-in reference detail pyramid is approximately 245 MiB; raw satellite COGs and provider tile caches remain outside the repository.


## Provider connection preparation

Photon 2 and Nemotron clients are fixture-tested in `src/photon-client.js` and `src/nemotron-client.js`. They are inactive and not wired to the app. The normal family exercise stays offline, text extraction remains simulated, and real sending remains disabled. The [integration notes](docs/INTEGRATIONS.md#inactive-provider-clients--november-8-preparation) describe the tested contracts and the remaining authenticated end-to-end acceptance.
