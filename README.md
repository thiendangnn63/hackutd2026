# Family Response · HackUTD 2026

A working **local, fictional disaster-response demo** for the grandparents inquiry story. A family member opens a contact concern, the app selects eligible community participants, a simulated SMS sighting becomes unverified evidence, and a demo officer records a verified outcome while any assistance request stays open.

**This is not an emergency service. Do not enter real personal, patient, or emergency information.** Nothing is sent to a phone, an AI provider, a public alert network, or a remote database. The interface labels simulated components throughout. The name is a working label.

## Run

Requires Node.js **22 or later**. There are no runtime or development dependencies to download.

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
- `public/`: dependency-free responsive web UI.
- `test/`: executable behavior/security regression tests.
- `docs/API.md`: shared frontend/backend contract.
- `docs/INTEGRATIONS.md`: exact boundaries and future integration gates.

The local data file `.data/state.json` and `.env` are ignored by Git. The app does not read any key for an external service. Adding a key to `.env` cannot activate a send or inference call.

## What works versus what is pending

**Implemented:** local case intake; stored reports; scoped dry-run recipient selection; simulated SMS inquiry/acknowledgment/family updates; source/time-linked observations; duplicate suppression; opt-out; officer evidence review; separate assistance state; restart persistence; reset; and a browser console.

**Simulated:** emergency alert, every SMS, model extraction, all people/locations, and the officer identity. The extraction parser recognizes scripted examples and conservatively routes other input to review. It is not suitable for real incoming reports.

**Not integrated:** Photon provisioning or webhooks, real send/reply/delivery tests, Lightning/Nano Omni inference, satellite/image analysis, custom training/model results, real authentication/roles, secure photo uploads, retention policy, agency authorization, and production deployment. This milestone does not satisfy the live-SMS acceptance criterion yet.

## Before any real integration

Keep credentials in the git-ignored `.env`, never in chat, frontend files, a notebook, or a commit. Use `.env.example` as the template. Do not enter a key until the integration step needs it.

Live messaging needs the exact Photon product/API and number verified, secure webhook authentication, consented test recipients, message content/purpose, and an explicit total spending limit within available credits. Existing credits are not a guarantee of zero charges. Live model inference likewise needs account access, input restrictions, and cost approval confirmed. The offline demo will continue to work without them.

Do not expose this server publicly. Demo role selection is not authorization. Production requires authenticated users, case-scoped access controls, secure identifiers, protected storage, data minimization/retention, rate limiting, audit controls, and an approved incident/verification policy.
