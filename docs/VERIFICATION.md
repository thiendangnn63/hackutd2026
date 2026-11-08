# Release verification

## Initial public release

| Check | Final release result |
| --- | --- |
| Syntax and metadata, `npm run check` | 80 JavaScript files passed syntax checks, and package metadata passed. |
| Full Node suite, `npm test` | 549 tests passed, zero failed. |
| Source whitespace, `git diff --check` | Clean. |
| Python checks | 40 passed, including 31 imagery, geometry, model import and water-change checks and nine training tests. |
| Public release and downloadable model | Published tag `beacon-demo-2026-11-08` resolves to reviewed source `d65fd59b79d99aa9449217b244176c72e167274f`. At initial publication, both `main` and `codex/beacon-demo` pointed to that commit. The model ZIP was downloaded from the public release and its SHA-256 matched the model card. [Release](https://github.com/thiendangnn63/hackutd2026/releases/tag/beacon-demo-2026-11-08) |

## Fresh public checkout

A fresh clone of the public repository passed all 549 Node tests and 80 JavaScript syntax checks. The rehearsal started successfully with the checked-in assets. Pressing Ctrl-C through npm reproduced a stale local server lock twice. The initial tag remains immutable.

## Shutdown patch

The patch release target is `beacon-demo-2026-11-08.1`. Both the rehearsal and live-test launchers handle repeated termination signals idempotently so that the first shutdown can finish releasing its lock. Two subprocess regressions exercise this behavior. A real terminal run of `npm run demo` followed by Ctrl-C exited with status 0 and removed the lock.

| Patch source check | Verified result |
| --- | --- |
| JavaScript syntax and package metadata | 81 JavaScript files passed. Package metadata passed. |
| Full Node suite | 551 tests passed, zero failed. |
| Python checks | All 40 passed across imagery, geometry, model import, water change and training. |
| Source whitespace | `git diff --check` passed. |

The initial public tag and its model download retain the source and checksum listed above. The patch preserves the saved exercise and keeps the provider integration inactive during rehearsal.

## Verification details

- The prior scoped iMessage/Nemotron checkpoint passed 484 Node tests and 69 JavaScript syntax checks. The ordinary loopback app kept live sending disabled. The saved exercise remained unchanged throughout the final checks with SHA-256 `dd8fa2080d9aafd817b85dbeb1ada55dd51b227949c965b2bbe713ed729a2fa9`.
- Browser fixture checks exercised raw capture, source-grounded proposals, human acceptance, separate reply approval, send and delivery status, plus STOP. The offline rehearsal exercised message receipt through officer verification with a simulated reply in the local conversation. Explicit water tracking has its own action and idempotent regression tests; accepting observations alone creates no task.
- On the combined source, 42 tests passed across the demo extractor, rehearsal runtime, map comparison model/layer and explicit assistance action. The assistance tests include a resolved welfare case, a completed legacy task, duplicate clicks, stale source or token and unaccepted observations. The targeted tests are a subset of the final Node suite. After the change-example control and hatch legend landed, all 11 focused map model/layer tests passed.
- All 40 Python checks passed, including 31 imagery, geometry, model import and water-change checks plus nine training tests.
- All 10 Python water-change tests passed using the three bundled index PNGs. Offline regeneration reproduced the checked-in 159,314-byte JSON byte-for-byte, SHA-256 `a302c2b508f9ab87907f0f2cfa367e6da5ce1426a8d7d1fd1ba8004df64a89d8`. The red request scale is fixed at 0–300. Amber uses a separate fixed water-index-difference scale and labels missing paired observations.
- The optional model ZIP matched its independently documented SHA-256 `93a62ca7e895e29d51733a57bbe777837bfa27dfbea50d6b0e1b7248228dc1e4`. Its listed artifact checksums matched. Local CPU inference reproduced a held-out crop prediction. The latest browser inference on a known held-out crop took 2,267 ms and returned the same 97.1% model score for no damage. The verified model SHA-256 is `78414e4f5076e02afcd65018ede5b78575b785df9398fce41301faac5c3fa329`. [Model verification and limitations](MODEL_CARD.md)

The rehearsal uses local rules and simulated phone delivery. Hosted Nemotron inference and actual iPhone delivery were not exercised by these checks. No paid GPU or model work was used.
