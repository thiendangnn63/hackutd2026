# Map-first UI checkpoint · November 7, 2026

The owner requested a clean, minimalist redesign with a freely movable map, zoom-dependent tiles/subtiles, red assistance demand, blue hospitality suitability, historical imagery overlays, points of interest, messages, and name-based information lookup.

The implementation is a dependency-free, local workspace with a white header and navigation rail, compact floating controls, and a full-height map. On mobile the rail becomes bottom navigation, the overview panel can be opened on demand, and area details use a bottom card. Map labels, facility icons, and unknown-area hatching retain their screen size at high zoom.

## Current behavior

- Free drag panning; wheel and two-finger pinch zoom; keyboard +/−, arrows, 0 and Escape; fit Houston. Pointer cancellation and pinch-to-drag transitions cannot accidentally open a tile.
- Official Houston-only polygons and historical aerial mosaic retained. Neighborhoods switch to clipped 2×2 cells at 2.2× zoom and 4×4 at 5×. Cells without area are omitted, and offscreen cells are removed from the Tab order.
- Red opacity scales linearly to the maximum visible-detail-level request count, with the maximum displayed in a legend. Filtering a need category changes the map counts and scale. No-report areas remain unknown; the coverage queue and unlocated requests remain accessible. Urgent medical cases in quiet neighborhoods remain individually visible in area details.
- Blue opacity represents fictional hospitality planning scores derived from fictional power, water and access inputs. These inputs are independent of report volume and imagery. Unknown scores remain hatched. Detail cards show the inputs and unverified planning status.
- Six fictional distribution/shelter/medical markers show resource, capacity and unverified status. Category checkboxes control visibility.
- Map imagery controls switch between the bundled aerial mosaic and boundaries, with aerial and tile opacity sliders. The archive has a dropdown for the actual imported Harvey pairs and a draggable before/after comparison with an accessible slider. The existing trained-model panel remains available below it.
- Messages groups raw incoming reports and simulated outgoing messages by case. People searches existing subjects/participants and related case descriptions, locations and message text. Person records keep last-known information, raw reports, times, welfare state, and officer review distinct. The existing intake, outreach, SMS lab, evidence review, independent assistance, reset and audit workflows remain in Casework.

## Data boundaries

Houston's existing fixtures contain neighborhood totals, not actual report coordinates. Subtile coordinates are explicitly synthetic, sampled deterministically inside the official region polygons. Request totals and each overlapping category sum are conserved. Hospitality and facility data are fictional planning inputs. No government/provider connection or new operational assessment has been established.

One Houston aerial mosaic is georeferenced; per-pixel capture dates are unavailable. The three imported Harvey satellite pairs support real visual comparison but do not have a verified placement on the Houston dashboard. The UI keeps those study areas separate instead of assigning fabricated geographic positions or dates. At deep map zoom the city overview mosaic naturally has limited resolution.

No runtime dependencies, paid APIs, external map requests, or credentials were added. Loopback binding, same-origin mutations and the static-file allowlist remain enforced. No public push or deployment is part of this checkpoint.

## Verification

`npm run check`, all 70 automated tests, and `git diff --check` pass. Automated checks cover the existing domain/HTTP/model boundaries plus actual-geometry containment, holes, count conservation, camera anchors, pinch/drag behavior and case-scoped search. Browser checks use an isolated in-memory server so the existing persisted exercise is not reset.

Verified in a real browser: desktop map render and pan; neighborhood and subtile selection; keyboard zoom/pan/reset; mobile pinch, cancellation, overview and detail cards; red/blue layers; zero-report scenario; imported image loading and dropdown/overlay comparison; family intake → simulated outreach → raw SMS → person search → conversation, with welfare remaining unknown after an unverified sighting. The model inference implementation is unchanged.

## Lessons for follow-up work

Screen-space map annotations must scale inversely with camera zoom; otherwise labels and hatching overwhelm the map. Mobile detail cards must reserve reachable map controls. Report observation time must not be used as conversation delivery order: show it separately and order incoming messages by receipt time. Synthetic subdivision must conserve parent/category totals and must never silently become purported geocoding. Additional city imagery needs a real extent/CRS/acquisition contract before it can join a geographic history selector.


## Iteration 2 · continuous UI refinement

The owner requested an ongoing review → improve → verify loop. This pass improves the map and record workflows while preserving existing integration boundaries.

- Messages and People now have scoped filters, clearer counts, stronger name ranking, retained keyboard focus/list position, and mobile list/detail navigation with back buttons. Conversation views keep observation and receipt times distinct.
- Explicit person-to-conversation links clear stale message filters, and the message lab inherits the selected conversation's case. Unassigned/orphan reports have a human-review inbox rather than disappearing. Participant records show their own reports and addressed messages; only case-subject records display that case's officer welfare review. Assistance-needed status uses an amber treatment, with open assistance tasks shown separately.
- Archive dropdowns retain focus and comparison position. Search has an accessible clear action; no duplicate native clear icon is shown.
- Map Overview can be hidden on desktop. A selected-area breadcrumb allows return to Houston/parent areas; zoom buttons animate briefly and respect reduced motion. Search Enter opens the matching area, and / focuses neighborhood search.
- All mobile detail types close Overview before appearing. Basemap choice survives scenario changes; an overlay opacity of zero really hides the overlays. Tile redraws retain selected-region/cell state and offscreen keyboard exclusions.
- Hospitality values now aggregate a fixed 4×4 fixture set. Area-weighted scores and explicit known/unknown utility coverage remain coherent across zoom levels, and known capacity is conserved.

Staged validation: syntax checks and all 81 automated tests pass. Browser regression checks cover stale-filter links, case context in the lab, raw unassigned reports, keyboard-focus preservation, mobile list/detail/back navigation, hidden Overview reopening, mobile unlocated cards, retained basemap choice, zero-opacity overlays, offscreen tab exclusions, and retained imagery comparison position. Tests use an isolated in-memory exercise; the owner's saved cases remain untouched.

Lessons: review state belongs to the named case subjects, not every participant linked to the case. Cross-tab navigation must carry explicit case context. Map redraws must reconcile selection and keyboard state. A hierarchy must aggregate fixed data rather than generate unrelated values at each detail level.
