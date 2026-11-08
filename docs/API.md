# Demo API contract

All data is fictional; the HTTP server binds only to 127.0.0.1. JSON errors use `{error: message}`. All successful mutations return the full state plus action metadata (`caseId`, `duplicate`). Browser UI fetches GET /api/state initially then uses state in mutation responses.

State:
- `mode: 'simulation'`, `scenarioTime` ISO timestamp, `incident: {id,name,active,tiles:['A1','A2','B1','B2'],policy:{maxTiles:2,locationMaxAgeMinutes:120,maxRecipients:20}}`
- `participants: [{id,name,phone,currentTile,locationReportedAt,optedIn,source:'fixture'}]` (555 fictional numbers only)
- `cases: [{id,subjectNames,description,reporterId,lastKnownTile,lastContactAt,searchTiles,consentToOutreach,reviewState:'open'|'awaiting_review'|'follow_up_requested'|'resolved',locationState:'unknown'|'unverified_sighting'|'verified_location',welfareState:'unknown'|'confirmed_safe'|'assistance_needed',outreachState:'needs_review'|'ready'|'queued'|'stopped',createdAt,reportIds,verification:null|{officerName,note,evidenceIds,verifiedAt},policyReasons:[]}]`
- `reports: [{id,providerEventId,senderId,caseId,text,observedAt,receivedAt,processingState:'processed'|'needs_review',processingPath:'deterministic'|'simulated_extraction'|'failed',observations:[{id,type:'sighting'|'self_check_in'|'water_need'|'road_blockage'|'correction'|'unknown',summary,sourceSpan,quantity:null|number,location:null|string,verification:'reported'}],reviewFlags:[]}]`
- `assistance: [{id,caseId,reportId,type,summary,status:'unassigned'|'completed'}]`
- `outbox: [{id,caseId,recipientId,kind:'inquiry'|'acknowledgment'|'family_update',text,status:'simulated',createdAt}]`
- `audit: [{id,at,action,detail}]`; `integrations:{photon:'not_connected',nemotron:'simulated',broadcast:'simulated'}`

Endpoints:
- POST /api/cases `{subjectNames,description,reporterId:'mom',lastKnownTile:'A1',lastContactAt:'2026-11-07T12:00:00Z',searchTiles:['A1'],consentToOutreach:true}`. Opens case; ready vs needs_review by policy. No automatic real messaging.
- POST /api/cases/:id/outreach `{}`. Selects fresh opted-in participants in search tiles, excluding reporter. Queues one simulated inquiry per case/recipient. Repeated calls do not duplicate. Needs review is blocked.
- POST /api/reports `{providerEventId, senderId:'neighbor-1',caseId,text,observedAt:'2026-11-07T14:20:00Z',simulateFailure:false}`. Preserves event, deduplicates IDs, deterministic STOP/CHECKIN or simulated extraction. Sighting never verifies safety. Family receives clearly unverified update. Need remains a separate task.
- POST /api/cases/:id/verify `{officerName:'Officer Rivera (demo)',evidenceIds:['R...'],note:'Direct fictional responder check-in completed.',welfare:'confirmed_safe'|'assistance_needed',resolve:true}`. Requires selected report evidence plus meaningful basis note. Demo officer role only. Stops inquiry outreach, keeps assistance open. Family update records outcome.
- POST /api/participants/:id/consent `{optedIn:false}`. Stops future inquiries.
- POST /api/reset `{}`. Resets fictional state, no external effects.

Seed: Mom (`mom`); eligible contributors `neighbor-1` in A1 and `neighbor-2` in A2. Other fixtures illustrate stale, opted-out, outside-area exclusions. Case `C104` (unanswered Elena Brooks case) remains open; grandparents flow creates C105. Subject demo names: Rosa and Miguel Santos. Example report: `I saw Rosa and Miguel at Oak School. They need water for two people and the road is blocked.` Include observed timestamp separately. Corrections/negations enter review without asserting positive facts. The extractor is explicitly simulated, not a Nemotron call. Zero API calls or cost.

## Optional satellite model integration

This is a separate historical imagery panel. It never mutates family case state.

- GET /api/satellite: availability, model provenance, held-out metrics, attribution, demo tile pairs and building predictions. Building estimates use only model damage_class/probabilities; reference_label is intentionally stripped. Before import: available=false, no fabricated tiles/predictions.
- GET /api/satellite/images/:filename: PNG from the imported tile-pair allowlist only. No arbitrary file paths.
- POST /api/satellite/infer `{tileId,buildingId}`: real local CPU inference for one existing bundled crop. Requires successful checkpoint validation, same-origin request, unchanged model checksum, and at most one in-flight request. No shell command interpolation. Returns prediction with source=local_model_inference, estimated state, uncalibrated probabilities, duration and model hash. Cached outputs are source=cached_model_output.
