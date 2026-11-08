# Beacon in three to five minutes

An officer receives a neighbor’s report about fictional case C104, records what was reported, tracks a water request and verifies welfare separately. Start with `npm run demo` and open [Beacon](http://127.0.0.1:4173/#mayor). The phone, interpretation and delivery in this walkthrough are local simulations. The hosted Nemotron and Photon test has its own launcher. [Live-test setup](PHONE_DEMO.md)

| Time | What to show |
| --- | --- |
| 0:00–0:40 | On **Map**, compare a high-demand area with a quiet one. Red counts fictional open assistance requests on a fixed 0–300 scale across zoom levels. The blue/cyan historical flood views show dated observations. Toggle **Before / after change**, then use **View change example** in the map legend to inspect a strongly observed amber cell. The red scale stays fixed. Zooming into a neighborhood reveals the individual planning areas. |
| 0:40–1:20 | Open **Casework → Offline phone rehearsal**. Choose **Sighting example**, then **Receive simulated message**. The neighbor reports seeing Elena and asks for water. The original wording is saved first. The local interpreter suggests observations for review. |
| 1:20–2:10 | Select the new C104 report and choose **Open report for review**. Expand its suggested observations, compare the sighting and water need to their source quotes, enter a reviewer name and review note, then **Accept selected observations**. Click **Track water assistance** on the accepted water need. The task is unassigned. Welfare still reads unknown. |
| 2:10–2:50 | In the phone panel, read the fixed reply. Choose **Approve simulated reply**, **Simulate sending reply**, then **Check simulated delivery**. The first send result is accepted. Delivery becomes confirmed only after the explicit check. In **Messages**, open C104 to see the original and the simulated outgoing reply. |
| 2:50–3:45 | In **People**, open Elena’s record. Return to **Casework → Case review** and select C104. Select the accepted report as evidence. For this exercise, role-play a *separate direct check-in* with Elena. Enter the responder’s fictional confirmation in **Verification basis**, select the appropriate welfare outcome, then **Verify outcome & stop inquiry**. Open **Assistance** and show that the water task remains open. |
| 3:45–4:30 | Return to the rehearsal panel. Choose **STOP** and **Receive simulated message**. Outreach consent switches off and further simulated replies are blocked. Choose **Reset exercise** and confirm to restore the rehearsal fixtures for the next run. The original family exercise uses a separate save. |

## Reading the impact layers

The **Before / after change** overlay uses amber for an increase in the satellite water signal. Its baseline is August 15, 2017, with August 30 or September 1 as the comparison date. The scale stays fixed across zoom levels. A grid cell averages positive MNDWI differences only where both images have valid data. Legend values equal that index difference multiplied by 100, with 100 and above sharing the top color. Jointly valid pixels cover about 12.1% of the product extent on August 30 and 23.3% on September 1. Sparse diagonal hatching means the comparison is unavailable. The legend reads **Not damage or flood severity**. Red assistance counts and blue/cyan historical flooding retain their own legends. **After image for amber change** selects the comparison independently of the basemap. **View change example** focuses the strongest cell on that date by mean positive change times paired coverage, requiring at least 50% coverage. It preserves both the comparison and basemap dates. Uncheck **Before / after change** to hide amber while retaining the assistance and imagery context.

## Optional minute for the trained damage model

In **Imagery → Trained damage model**, compare a historical xBD before/after pair and select a known building crop. The trained six-channel classifier estimates a building-damage class and can run on local CPU after import. Its historical crops are not georeferenced to the Houston assistance map. Amber water-signal change measures a different quantity.

Download the optional [original model ZIP](https://github.com/thiendangnn63/hackutd2026/releases/download/beacon-demo-2026-11-08/utd_xbd_model.zip). With the documented Python environment installed, import it from the project root:

```sh
npm run import:model -- /path/to/utd_xbd_model.zip --sha256 93a62ca7e895e29d51733a57bbe777837bfa27dfbea50d6b0e1b7248228dc1e4
```

The importer verifies the archive, files and model, then checks a real CPU prediction. It keeps model data outside Git. Historical xBD/xView2 material carries attribution and CC BY-NC-SA 4.0 restrictions. [Model setup](../README.md#optional-trained-satellite-model) · [Model card and attribution](MODEL_CARD.md)
