# Beacon UI checkpoints · November 7–8, 2026

The owner requested a clean, minimalist redesign with a freely movable map, zoom-dependent tiles/subtiles, red assistance demand, blue hospitality suitability, historical imagery overlays, points of interest, messages, and name-based information lookup.

Beacon is a dependency-free local workspace with a dark glass header, navigation rail, restrained red/blue accents, compact floating controls, and a full-height map. Its signal/lighthouse mark is an original SVG with a matching favicon. On mobile the rail becomes bottom navigation, the overview panel can be opened on demand, and area details use a bottom card. Map labels, facility icons, and unknown-area hatching retain their screen size at high zoom.

## Current behavior

- Free drag panning; wheel and two-finger pinch zoom; keyboard +/−, arrows, 0 and Escape; fit Houston. Pointer cancellation and pinch-to-drag transitions cannot accidentally open a tile.
- Official Houston-only request polygons sit over historical aerial and satellite context that also covers the surrounding geography. Neighborhoods switch to clipped 2×2 cells at 2.2× zoom and 4×4 at 5×. Cells without area are omitted, and offscreen cells are removed from the Tab order.
- Red opacity uses a fixed 0–300 request scale at every subdivision and filter. The legend no longer changes with zoom; hierarchy appears only in the separate map-resolution caption. No-report areas remain unknown; the coverage queue and unlocated requests remain accessible. Urgent medical cases in quiet neighborhoods remain individually visible in area details.
- Blue opacity represents fictional hospitality planning scores derived from fictional power, water and access inputs. These inputs are independent of report volume and imagery. Unknown scores remain hatched. Detail cards show the inputs and unverified planning status.
- Six fictional distribution/shelter/medical markers show resource, capacity and unverified status. Category checkboxes control visibility.
- Map imagery controls switch between bundled geographic imagery and boundaries, with imagery and tile opacity sliders. The archive has a dropdown for the actual imported Harvey pairs and a draggable before/after comparison with an accessible slider. The existing trained-model panel remains available below it.
- Messages groups raw incoming reports and simulated outgoing messages by case. People searches existing subjects/participants and related case descriptions, locations and message text. Person records keep last-known information, raw reports, times, welfare state, and officer review distinct. The existing intake, outreach, SMS lab, evidence review, independent assistance, reset and audit workflows remain in Casework.

## Data boundaries

Houston's existing fixtures contain neighborhood totals, not actual report coordinates. Subtile coordinates are explicitly synthetic, sampled deterministically inside the official region polygons. Request totals and each overlapping category sum are conserved. Hospitality and facility data are fictional planning inputs. No government/provider connection or new operational assessment has been established.

The city and metro aerial mosaics and NASA regional/global composites have recorded geographic extents. NAIP per-pixel capture dates are unavailable; Blue Marble is historical 2004 context. The three imported Harvey satellite pairs support real visual comparison but do not have a verified placement on the Houston dashboard. The UI keeps those study areas separate instead of assigning fabricated geographic positions or dates. At deep map zoom the city overview mosaic naturally has limited resolution.

No runtime dependencies, paid APIs, external map requests, or credentials were added. Loopback binding, same-origin mutations and the static-file allowlist remain enforced. No public push or deployment is part of this checkpoint.

## Verification

The initial checkpoint passed `npm run check`, 70 automated tests, and `git diff --check`. Current validation appears in the latest iteration below. Automated checks cover the existing domain/HTTP/model boundaries plus actual-geometry containment, holes, count conservation, camera anchors, pinch/drag behavior and case-scoped search. Browser checks use an isolated in-memory server so the existing persisted exercise is not reset.

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


## Iteration 3 · facility discovery and focused Casework

The Places map list makes all six enabled fictional facilities accessible alongside the marker layer. Map search matches facility names, resources and neighborhood names, and Enter opens the first result. Markers expose names on hover/focus, retain selected highlighting, and keep their card open across viewport resizing.

Casework now separates review, new inquiry, the message lab, and assistance into explicit section links. The existing supplied example reveals the intake view. Successful new-case and raw-report submissions return to case review after the state update; the lab keeps its selected case. Duplicate reset actions were reduced to the header control while preserving the existing confirmation flow.

Browser verification covers facility search and category filtering, desktop/mobile facility cards, each Casework section, and a complete new C106 fictional grandparents flow: intake → automatic case review → scoped outreach → message lab for C106 → received report → automatic evidence review. Location remains an unverified sighting and welfare remains unknown. No new domain state, provider integration, dispatch, or external map request is introduced.

Lesson: a map marker needs an equivalent searchable list entry; a case workflow should navigate through focused tasks while preserving case context.


## Iteration 4 · readable text, touch targets and keyboard continuity

A browser contrast audit found multiple faint labels and captions in the initial white workspace. Supporting foreground colors were strengthened without changing the restrained hue palette; the sampled non-SVG text across Map, People, Messages, intake and imagery passed the large/small-text contrast thresholds after the change. This is a scoped browser check, not a claim of complete accessibility conformance. Focus rings are more distinct. Mobile resource labels and zoom controls have larger touch areas, text-entry fields use 16px type, and 320px map controls use a second row instead of overlapping.

Map detail cards close with Escape and return focus to the map. Opening and closing Overview/Imagery returns focus to a visible control. Offscreen POIs leave the Tab sequence; selecting an area clears the previous facility highlight. Map-list tabs now use a single Tab stop with arrow-key switching. Place labels declutter against one another and facility markers at low zoom, while retaining the city label in narrow full-city views.

Record filters and mobile Back controls retain useful focus. Changed name queries select the strongest direct match, while ordinary state refreshes preserve selection. Loading records show an explicit status and aria-busy. A stale initial record response cannot overwrite a newer state event. Participant histories include only their own addressed outgoing messages across known, null and orphan case references, including an unassigned CHECKIN acknowledgment. Search result counts are announced through a static polite live region. Status messages can be dismissed.

Successful intake and report navigation now follows an explicit local family-action-complete event rather than inferring completion from previous record counts. This fixes the case where the original app has loaded but the record-view snapshot is still pending. The API, domain states and external integration boundaries are unchanged.

Verification: syntax checks and 83 automated tests pass, including two new recipient-history regressions. Browser checks cover direct-name selection after a contextual match, filter/Back focus, post-submit heading focus, loading feedback, delayed-record-response protection with a real saved fictional case in the isolated in-memory server, unassigned CHECKIN history, Escape/focus return, offscreen POIs, selection clearing, narrow-screen control separation, and mobile input type size.

Lessons: a quiet interface still needs readable captions and dependable touch targets. Navigation should follow confirmed action outcomes, not inferred differences between asynchronously loaded snapshots. A message belongs in its actual recipient’s history even when case assignment is unresolved.


## Iteration 5 · viewport fit and long-session reading

Short windows previously allowed the navigation rail to expand the main grid beyond its assigned height, and a fixed minimum zoom could clip Houston on wide displays. The grid now stays within the viewport; short Overview and imagery panels scroll instead of clipping their contents. Landscape windows use a compact rail and an optional Overview drawer. Short record views use focused list/detail navigation, with sticky Back/context controls, rather than a clipped conversation pane.

Fit Houston now uses projected city bounds and actual usable viewport insets, including the overview width and attribution footer. Its zoom floor adapts to the fitted view; wheel/button/keyboard/pinch zoom retain their anchor behavior below the former 0.4 floor. Region focus uses the same bounds-fit helper. New camera regressions cover wide/short viewports, asymmetric insets, finite fallback behavior and low-floor gestures.

People and Messages retain per-record/thread reading offsets across route changes and state refreshes. A thread reader already near the end follows new content; a reader inspecting an older message keeps that position. Explicit mobile selections reveal the heading/Back, and Back restores the list context. Person outgoing history defaults to twelve entries with a shown/total count and Show all / Show latest 12 controls; expanding reveals and focuses the first older entry. These view caches are local to the open page and are cleared by exercise reset.

Validation: syntax checks and all 87 automated tests pass. Browser checks confirm full-city containment at 1024×600, 844×390, 667×375, 1920×540 and 2560×720; wide-window button and real touch pinch zoom; reachable scrollable landscape lists and facility cards; non-clipped short inboxes; retained reading offsets across Map round trips; preserved older-message reading after new input and end-following when appropriate; explicit 12-of-19 history expansion/collapse; and heading/Back visibility on mobile selection.

The reset/cache check was performed only after the live 4174 process was verified to run createApp(new Store()) with a null persistence path. The owner's 4173 persisted exercise checksum was unchanged before/after; its cases were not reset. No public push, deployment, external provider call, or welfare/assistance contract change is part of this pass.

Lessons: fit a map to its usable viewport rather than a fixed zoom floor. A short layout needs reachable scroll surfaces, not merely smaller typography. Updating data should preserve the user's reading position; history truncation needs an explicit route to older content.


## Iteration 6 · Beacon, dark glass and complete geographic context

The owner named the product **Beacon** and requested a minimal dark glass design with red and blue accents. The shared palette now uses dark neutral surfaces, thin borders and blurred translucent map controls. Red identifies reported need; blue identifies hospitality inputs and navigation. Text contrast, focus rings, keyboard behavior and the existing compact layouts remain explicit. Header copy was shortened, page titles and package metadata use Beacon, and the header/favicon use an original scalable signal/lighthouse mark at `public/beacon-logo.svg`. No remote font or UI dependency was added.

Previously blank surroundings and municipal holes now show real geographic imagery: a global and Texas/Gulf NASA Blue Marble background, a wider transparent USGS/USDA NAIP metro image, and the existing city aerial detail. Each uses its actual recorded EPSG:4326 extent; only request tiles and selections are clipped to Houston. Official no-data pixels remain transparent rather than black or fabricated. Shared opacity/boundaries controls operate on the complete raster stack. Panning is bounded by the global image extent, without repeating geography. All rasters are historical; they have different dates/resolutions and do not establish current damage, access or shelter suitability. See `HOUSTON_DATA.md` and metadata for source URLs, dimensions, dates and checksums.

Map search now searches all neighborhood names and enabled facilities using literal multiword terms. It exposes an actual result count, and Enter opens only an actual match. Unmatched searches cannot open the unrelated unlocated-review card. Choosing a queue tab clears the query and restores that queue. Existing request totals and category filters are unchanged.

People and Messages safely highlight original text with DOM nodes, preserving accents, Unicode and literal HTML-like text. Message search has Previous/Next and Enter/Shift+Enter navigation. It prefers messages containing every term, labels partial matches as related, and distinguishes case/reference matches from message-content matches. New queries and explicit thread selections reveal the matching message; tall bubbles reveal their first highlighted text. State refresh and tab round trips retain reading position. Compact context/Back controls remain sticky because detail layouts allow overflow to reach their outer scroll surface.

Validation: JavaScript syntax and **103 automated tests** pass; **8 Python geography checks** pass; all three new context rasters decode at their recorded dimensions and match SHA-256. A scoped non-SVG text contrast audit passed across Map, People, Messages, intake and Imagery; this is not a complete accessibility conformance claim. Browser checks cover actual no-match and multiword facility search, red/blue layers, zero-report scenario, imagery opacity zero and boundaries choice retained across scenario changes, full-city fit at 2560×720, 844×390, 390×844 and 320×640, reachable compact Back and matching text in a 574px-tall message, Prev/Next/Shift+Enter, literal markup remaining plain text, clear no-message state, and reading offsets retained across state refresh and Map round trips. Family intake/outreach/report checks used only the verified in-memory port-4174 exercise. The saved port-4173 exercise checksum remained unchanged.

Lessons: a search hit should be visible where the user is reading, not merely make its conversation appear in a list. Sticky context cannot work through a non-scrolling overflow-hidden ancestor. Expanded map backgrounds need their own honest extents and provenance while the operational overlay keeps its original geographic scope. A dark glass interface still requires readable captions and restrained blur.


## Iteration 7 · sharper zoom, named geography and actual Harvey water imagery

The owner asked for imagery that sharpens as the map zooms, real street/landmark context, and actual flooded-event imagery with bands that make water visible. The completed reference pyramid has 206 checked local image tiles down to roughly 2.8 m per output pixel. Viewport selection loads only the required tier and bounded fallback/prefetch. Named roads and 452 real geographic landmarks appear by scale, with collision/controls avoidance; their search accepts ordinary street types while preserving source names. Same-name road geometry is retained across classes, axis-aligned roads have usable fit bounds, and cached geographic search is fast enough for typing. These reference markers establish no resource or operating status.

The default image mode is actual dated Sentinel-2 green/SWIR MNDWI water emphasis, with a same-date true-color option and a before/during-Harvey capture selector. Cyan represents stronger continuous open-water signal, including permanent water. Twenty-meter analysis and clear-observation fractions are shown; dots identify unknown observation/context instead of dry ground. NOAA’s five acquisition days and four high-detail flooded areas provide real ~2.1 m aerial pixels. NASA/JPL’s published 30 m Sentinel-1 flood proxy is a separate labeled option with lower urban reliability and no dry-ground interpretation for unmarked pixels. Water imagery remains geographically unclipped across municipal boundaries; Houston-only fictional request counts remain separate. Broader incident coordination across jurisdictions is an accepted product principle, not a completed live coordination workflow.

The Baker Road and West Fork examples point to actual measured changes near named streets. Captures keep their dates across optical mode changes; same-day NOAA captures are chosen when available. User-set opacity survives scenario updates. Missing metadata and images have a real retry path, and unavailable RGB is not presented as ready. Outside a selected image footprint the view explicitly identifies reference context.

Map refinements also fix observed long-session friction: layer/filter detail refresh no longer steals focus or closes mobile Overview; closing every card returns usable map focus; manual center/screen scale survive window resize; Escape clears search before closing Overview; failed scenario loads clear stale clickable rows and expose retry. Context labels are placed around the visible panels and controls rather than underneath them.

Validation: JavaScript syntax and **127 Node tests** pass. **Eight geography and four pyramid tests** pass; all 206 detail files decode and match hashes, source-grid provenance, actual bounds and subpixel reprojection limits. Geographic references, nine NOAA products, three optical date pairs and quantitative indices, radar indicators, and 294 independent native COG pixel checks pass offline validation. Browser checks verify all four real zoom tiers, street names/search and real landmarks, water/RGB dates, NOAA Kingwood and Barker detail, radar palette/date, opacity/scenario retention, outside-capture disclosure, map/metadata failure recovery, focus behavior, viewport retention, and reachable 390px/320px mobile controls. The clean main exercise remains unmodified; fault injection and workflow QA use only the in-memory port-4174 server.

Lessons: image format alone cannot reveal water; the sensor bands, acquisition time, calibration and cloud mask matter. Preserve native resolution and unknown pixels. A geographic bounding box does not guarantee usable observation coverage. Same-name search must preserve all geometry, straight roads need finite fit bounds, and layer refresh must preserve the reader’s navigation context.


## Iteration 8 · stable legend, visible flooding and closer street detail

The owner reported that the legend changed while the strongest color did not, floodwater was hard to find, and close zoom did not sharpen. Assistance now has a fixed 0–300-request scale; hospitality remains 0–100%. The resolution pill was removed from the legend. Subdividing a request total no longer normalizes each level's hottest cell back to full red.

The initial city view now uses the published Sentinel-1 radar flood proxy. Show flooding is visible beside Imagery and opens actual August 30 Barker/Baker Road aerial imagery at full image opacity. NOAA keeps its own acquisition date instead of inheriting the poorly covered September 1 optical date. Optical mode can follow a displayed NOAA date where the same date is available. Open-water signal is named explicitly, with unknown observations distinguished from absence of flooding. Following owner feedback, the repeated observation-gap dots were removed; a quiet dimmed reference background and a plain swatch preserve the unknown meaning. Local quantitative checks found no usable September 1 optical pixels in the Barker/Baker Road fine crop; August 30 has about 71.36% usable pixels there. A single-date water index includes permanent rivers/lakes and is not a complete new-inundation map.

Progressive reference detail now stays enabled under all dated modes. Two bounded NOAA zoom-18 crops add genuine ~0.52 m sampling at Barker/Baker Road (August 30) and Kingwood (August 31), each with full observed coverage inside its recorded rectangle. These follow the coarser images in draw order; their exact bounds, source digest, sampling and checksums are recorded. All eleven NOAA products remain local. Camera, resize and pinch limits now share a 96× ceiling, allowing street views beyond the former 24× limit. Data resolution is never inferred from screen zoom.

Messages/People preserve focused controls across same-record refreshes and compact-layout transitions without stealing focus from outside controls. Archive comparison waits for both images, disables comparison on failure, exposes Retry pair and Refresh archive, ignores stale callbacks, and retains pair/slider position through visits and temporary empty inventories.

Validation: syntax checks and 148 Node tests pass. All eleven NOAA images decode and match recorded hashes, bounds, dates and reprojection limits; all 800 newly cached source tiles match their digests. Browser checks cover unchanged legend text through both subdivision levels, default radar, direct visible flood imagery, true ~0.5 m loading, closer street zoom, sharper reference tiles under radar, reachable 320/390px controls, focus/reading continuity, failed-image retry, two-image readiness, and pair/73% comparison retention through temporary unavailability. The saved main exercise is unchanged.

Lessons: a stable legend needs a stable color scale. Clear-observation coverage must be evaluated at the area and date being inspected. Reference imagery beneath a masked observation can look dry while the flood status is unknown. A closer camera needs both a higher zoom ceiling and real finer source pixels.


## Iteration 9 · local observation gaps and explicit recovery

Optical modes now report usable observations for the map rectangle being inspected, excluding the open Overview panel and footer. No-observation and outside-capture views identify reference context as unknown flood status. A clearly better available response-date capture can be selected explicitly without moving the camera; the clearer pre-Harvey capture is never silently substituted. Zero opacity exposes Show imagery; failed coverage metadata and source images have separate retry feedback. Both imagery groups share opacity state.

Show flooding chooses an available NOAA detail when Barker is missing, disables when no detail or map is ready, and remains a separate label-collision obstacle on compact maps. Short-window captions reserve the zoom/fit column; narrow short windows retain the date and44px recovery action without covering the footer.

Validation: syntax checks and159 Node tests pass. All three coverage summaries reproduce byte-for-byte from their source index masks offline. Browser fault checks on the RAM-only4174 server cover coverage503 retry, image failure/retry, partial/missing NOAA hotspots, scenario503 readiness/recovery, opacity0 and synchronized recovery, outside-capture panning, and explicit date changes with unchanged viewBox. Barker September1 correctly has no clear observation; Try Aug30 yields about68% of the unobscured desktop view. Checks at844×390,600×390,320×568 and320×390 retain reachable controls; the smallest no-observation caption does not overlap fit, zoom or the footer. Saved main exercise data and provider integrations remain unchanged.

Lesson: an image footprint and a loaded file do not establish a usable observation at the place being inspected. Coverage feedback must describe the current date/view and preserve an explicit distinction between missing observation and dry ground.


## Iteration 10 · compact controls and dependable search

Secondary map filters now use a native keyboard-accessible disclosure. Need categories, demo scenario and facility types remain available; the closed summary names active choices, including no places and the coverage exercise. Assistance and hospitality remain directly available. This leaves more room for priority areas in the default Overview. On compact maps, map buttons no longer cover Overview search; Overview and Imagery open one at a time, including the / search shortcut.

Map queue rows have stable UI identities. A search refresh after street/landmark loading preserves the focused result and the list/panel reading offsets. Reference readiness does not rebuild an unrelated normal queue. Mobile Messages now opens valid case/name-only search results on Enter even when they contain no messages. Typing still keeps the result list visible; message-content Enter/Shift+Enter navigation is retained.

Validation: browser comparisons reproduce focus loss to BODY before the fix and retained facility focus/scroll afterward using a gated-reference RAM-only server. Checks cover filter summaries and keyboard disclosure, assistance/hospitality switching, coverage/no-place settings, 320×640 and 844×390 control access, mutually exclusive panels across resizing with focused-panel retention, C104/Elena empty-conversation submission at 390×844, no-result Enter, and two matching reports with forward/backward navigation. A simulated report remains unverified with unknown welfare; its separate assistance appears in People. Local checks and final checkpoint results are recorded in the project timeline. No provider calls, cloud instances or paid tests were used.

Lessons: loading supplementary map data must not replace a focused result without restoring its UI identity. A compact search submission must work for the advertised name/case paths even when there is no message text to jump to. Secondary controls can be disclosed while their active state stays visible.


## Iteration 11 · priority visibility and predictable keyboard controls

Overview uses a shorter heading/metrics block and concise color captions. Redundant Response workspace and Map layers labels were removed. All three priority areas fit in the default 1280×720 map panel; the Filters disclosure is visible without scrolling at 320×640. Existing counts, ordering, legends, detailed planning cautions and queue access are unchanged.

People search now opens its selected result on Enter through the existing row action. Compact records reveal their heading and Back control. Typing and unmatched/blank searches leave the list in place; modified or composing key events are not submitted. Map shortcuts now ignore Ctrl, Meta, Alt, composing and previously handled events across the map canvas, search, / shortcut and queue tabs. Shift remains available for +.

Validation: browser checks reproduce the People Enter gap before the fix and verify Elena/Sam records, unchanged empty results, and Alt+Enter remaining in the list. A closer map view stays unchanged for Meta/Ctrl minus and Meta+0; plain plus/minus continue to zoom. Ctrl/ leaves map focus in place; / opens Overview search. At320×640, keyboard Coverage → first area → Enter opens the area card and closes Overview. Exact-handler offline comparisons retain all nine plain canvas cases and remove actions/prevents from all seventeen guarded canvas cases, with equivalent search/queue coverage. Local project checks and saved-state integrity are recorded at the checkpoint. No provider call, GPU or paid test is part of this iteration.

Lessons: captions and duplicate labels should not crowd out the working queue. Search submission should reuse the visible selected result’s action. Web-app shortcuts must preserve browser/system modifiers and composition.


## Iteration 12 · report provenance and capture consistency

People separates Original inquiry from the latest incoming report. The preview includes sender, unchanged raw text, processing/review label and separate received/observed times. Receipt order includes corrections, failed interpretations and commands; if any receipt time is unknown, the preview explicitly avoids claiming certain arrival order. Observation-time history and the family’s original last contact remain separate. STOP and CHECKIN have command/request labels instead of generic observation labels. Casework also labels the original inquiry. No report edits, new location claims or welfare transitions are introduced.

Each raw report can open its exact message. These links clear stale conversation filters and reveal/focus the correct bubble on desktop and compact screens. Unassigned or orphan-case reports open the existing human-review conversation rather than gaining a case association. The shared reveal routine also preserves matching-message navigation.

The message lab now accepts an unknown observation time, sends null instead of fabricating a timestamp, and explains that the raw message remains reviewable. Family last-contact requirements remain unchanged.

The capture dropdown follows the date actually resolved by the historical layer when a remembered date is missing. Empty capture inventories clear stale event images/date/source claims while reference context stays available. Retry can refresh an empty inventory; old image callbacks and older metadata responses cannot overwrite recovery. Remembered mode/date and opacity choices remain intact.

Validation: browser checks use only RAM-only servers. A newly received correction with an older observation becomes the preview; an extraction failure and an untimed STOP remain raw/reviewable without changing welfare. Source-message links clear stale filters and focus the exact case or unassigned message on desktop/mobile. A NOAA fixture removes the actual August 31 capture: image, caption, dropdown and source all use August 30 even though September 3 remains available. Same-date optical/RGB switching retains August 30. Seven records regressions cover receipt ordering, missing-time uncertainty, command classification and immutability; six actual-layer regressions cover missing dates, populated→empty clearing, stale callbacks/responses and recovery. Final project checks and saved-data integrity are recorded at the checkpoint. No cloud compute, provider message or paid model call was used.

Lessons: an original inquiry is historical source text, not a refreshed status. Latest receipt and latest observation answer different questions. A correction or failed interpretation must not disappear behind a positive sighting. Dropdown labels and rendered imagery need one date-selection decision; empty inventories must remove prior evidence.
