# Houston geography and historical imagery

These files are geographic context for a fictional local exercise, not emergency navigation or evidence of disaster damage. No real resident information is included. Sources were retrieved on 2026-11-08 UTC.

## Asset contract

- `public/data/houston-city.json`: WGS84/EPSG:4326 GeoJSON **Feature**, ID `houston`, with full-purpose Houston city geometry and `[west,south,east,north]` bbox.
- `public/data/houston-neighborhoods.json`: GeoJSON **FeatureCollection**, 88 official Super Neighborhoods plus one explicit coverage-remainder feature (89 total). Every feature has identical top-level `id` and `properties.id`, `properties.name`, `properties.kind` and an interior `properties.labelPoint` `[longitude,latitude]`. Official IDs are `houston-sn-01` through `houston-sn-88`, based on the City's stable `POLYID`. `houston-coverage-remainder` is a derived coverage area, not an official neighborhood. Its disconnected components include annexation corridors and mismatches between the two official layers. Do not omit it from zero-report review.
- `public/data/houston-geography-meta.json`: `cityName`, `regionDescription`, `bbox`, `sourceUrls`, `attribution`, `basemap`, `contextBasemaps` plus detailed processing, validation and image provenance. `basemap.file` is relative to `/data/`; `basemap.bbox` is the **returned export extent**, not an assumed matching extent.
- `public/data/houston-imagery.jpg`: historical USGS/USDA NAIP natural-color aerial mosaic, when `basemap.available` is true. This is an aerial image, not a current satellite observation.

Coordinates are longitude/latitude. Use the same linear longitude/latitude projection for SVG paths and all EPSG:4326 rasters, positioned from each image’s recorded bbox. Clip **request polygons and interaction hit regions** to the city Feature, respecting interior holes using even-odd fill/clip rules. Never substitute a rectangular city selection boundary. Independent municipalities remain outside the selectable Houston areas. Retain the entire extent including western annexation corridors, Kingwood and Clear Lake.

On November 8 the owner explicitly requested imagery throughout the formerly empty map. Geographic raster context may now show surrounding towns and fill city holes. This changes the previous city-cutout presentation; it does not expand Houston request membership. Context rasters are noninteractive and must never create synthetic neighborhoods or repeat/stretch geography beyond its own extent.

## Authoritative sources and scope

City of Houston Public Works' public GIS CAS map:

- City Limits (layer 2): https://mapsop1.houstontx.gov/arcgis/rest/services/CAS/CASMapViewer/MapServer/2
- Super Neighborhoods (layer 3): https://mapsop1.houstontx.gov/arcgis/rest/services/CAS/CASMapViewer/MapServer/3
- City GIS public-domain/attribution statement (Houston Limits Boundaries Package): https://www.arcgis.com/home/item.html?id=c3bfee99cbc14a899e4a603ee73203ee
- Official Super Neighborhood reference: https://www.houstontx.gov/superneighborhoods/2024-SN-Handbook.pdf

City geometry is the union of records where `SERVICE_TY = FULL` and `ENTITY_NAM = CITY OF HOUSTON`. The layer also has 746 LIMITED service/tax-area polygons, which are deliberately excluded along with the ETJ. Those areas must not turn neighboring communities into selectable Houston neighborhoods. The two FULL records include the main city and a small separate polygon; neither is discarded. Main-city record has no effective date, so the files are a current public-service snapshot, not a claim that every boundary was surveyed or updated in 2026. Neighborhood metadata says the layer is subject to change.

City GIS information is provided in the public domain with source citation appreciated. Preserve attribution to City of Houston / Houston Public Works / Planning and Development Department. GIS accuracy, completeness and suitability are not guaranteed. This is a visualization, not a legal determination of jurisdiction.

## Imagery provenance and reuse

Official public USGS image service:
https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer

The service describes its USDA National Agriculture Imagery Program (NAIP) data as public-domain orthophotography and supports public read-only image exports. No account, API key, subscription, paid provider or usage credit is used. The export requests the default natural-color renderer, EPSG:4326, 1200 × 900 pixels, JPEG. Preserve attribution **USGS, USDA, The National Map**. The service copyright/refresh text is stored in metadata, but it is **not** a capture date. This statewide/national mosaic has varying historical capture dates; exact per-pixel capture dates are not supplied by the export. Display “Historical NAIP aerial imagery; capture date varies.” Never label it live, current damage, Hurricane Harvey imagery, or a model observation.

### Wider historical context

The raster stack, from broadest to finest, contains:

- `earth-context.jpg`: NASA Earth Observatory Blue Marble: Next Generation, August 2004 global monthly composite, 5400 × 2700, bbox `[-180,-90,180,90]`.
- `houston-context.jpg`: NASA GIBS Blue Marble 2004 regional composite, 2400 × 1760, bbox `[-103,24,-88,35]`.
- `houston-metro.png`: historical USGS/USDA NAIP metro mosaic, 1200 × 923, bbox `[-96.8,28.8,-94.2,30.8]`. The official PNG32 export marks all-band-zero no-data pixels transparent, allowing genuine NASA context to remain visible underneath.
- The existing Houston detail image, positioned at its recorded city export extent.

All layers are bundled locally. The Imagery control hides/shows the entire stack and sets its shared opacity; tile opacity remains independent. Pan is bounded to the finite global image extent. Different dates and resolutions are visible context, not evidence of change between comparable observations. Deep zoom remains limited by the cached raster resolution.

Sources and terms: [NASA Blue Marble base maps](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-map/), [NASA GIBS access documentation](https://nasa-gibs.github.io/gibs-api-docs/access-basics/), [NASA imagery reuse guidance](https://www.nasa.gov/nasa-brand-center/images-and-media/), and the USGS image service above. Attribute NASA Earth Observatory / NASA GIBS and USGS, USDA, The National Map; do not imply endorsement.

`contextBasemaps` records each exact source URL, EPSG:4326 extent, dimensions, historical date description and SHA-256. `scripts/prepare_context_imagery.py --offline-check` decodes and validates all three context files without network. Without that flag it can retrieve a missing file only from the recorded official source and rejects a changed checksum pending review. This developer utility never runs in the app.

## Processing and verification

Source geometry precision is preserved without simplification, coordinate rounding, dropped islands or holes. Invalid source polygons, if any, are repaired using Shapely's zero-distance buffer. Each neighborhood is intersected with the city and has earlier-numbered neighborhood coverage subtracted to ensure deterministic nonoverlapping assignment. All remaining city area is included in the coverage feature. This avoids both outside-city selection and forgotten zero-report land.

Validation results are stored under `checks` in metadata:

- 89 valid polygonal region Features, including 88 official neighborhoods.
- City geometry valid.
- Outside-city area: zero.
- Uncovered-city area: zero.
- Aggregate overlap: zero within floating-point tolerance (`1e-12` square degrees).
- Geographic spot checks: downtown Houston, Kingwood and Houston's Clear Lake are inside; Bellaire, West University Place, Katy, Pasadena, Sugar Land and Humble town-center coordinates are outside.

Regenerate with Python and Shapely: `python3 scripts/prepare_houston_geography.py`. The script makes read-only public GIS requests and writes only these public geography assets. `--skip-imagery` prepares vectors alone. An optional `--cache-dir` reuses `2.json` and `3.json` source FeatureCollections. No network request occurs at app runtime; all visualization assets are local. Do not use the script to read or modify demo state, model bundles, secrets or personal data.

If regenerating the vector snapshot with the older preparation script, preserve the reviewed `contextBasemaps` provenance entries and context asset files; the context verifier consumes that reviewed metadata. No context regeneration is needed for ordinary app operation.


## Zoom detail and street references · November 8, 2026

The local `houston-imagery-pyramid.json` describes 206 real WebP tiles at four output samplings: about 22.01, 11.11, 5.56 and 2.78 meters per pixel (245.2 MiB total). They are resampled from the public USGS/USDA **USGSImageryOnly** cache, primarily 2017–2021 CONUS imagery, with finer native ground sampling of about 16.58, 8.29, 4.14 and 2.07 meters. These are historical reference images, not evidence of Harvey flooding. `houston-imagery-source.json` records the official EPSG:3857 cache grid. Offline Pillow mesh reprojection maps the source pixels to each exact EPSG:4326 rectangle; the worst analytic error bound is below 0.000779 output pixel. Manifest checksums and source-grid digests identify each asset. Missing files remain unavailable, and only manifest-listed local tiles can be requested.

`prepare_cached_imagery_pyramid.py` is the recommended reproducer, using the grid/encoding helpers in `prepare_imagery_pyramid.py`. Source tile caches stay under an external temporary cache. At runtime the browser chooses an appropriate real tier for the geographic viewport, prefetches a bounded margin, retains coarse support, and mounts at most 20 detail nodes on desktop or 12 on narrow windows. No remote map SDK or runtime provider request is involved.

The named-road snapshot contains 37,318 exact-name/rank features, retaining 47,557 connected paths and 236,842 vertices. The 452 geographic landmarks comprise 379 parks, 43 libraries, eight airports and 22 civic halls. `houston-labels-meta.json` records official City of Houston and USGS sources, vintage/retrieval, source disclaimers and coverage checks including Kingwood, Clear Lake and the western areas. These are geographic context references, with no operating/access status. Modern GIS labels are not a reconstruction of the 2017 street network. Source names remain unchanged; only search aliases normalize common street types and directions.

## Real Harvey event imagery and water emphasis

`houston-water-imagery.json` describes actual **Copernicus Sentinel-2 L2A** scenes acquired on August 15, August 30 and September 1, 2017. Public Earth Search mirror COGs retain the original product/granule IDs, per-band transforms, scale/offset and source hashes. The mapped extent is `[-95.94,29.48,-94.99,30.14]`, displayed on a common 4600 × 3660 EPSG:4326 grid with **20 m native analysis**. Each date has paired true color and a continuous water-index rendering; they share the same valid-observation mask.

Water emphasis uses **MNDWI = (B03 − B11) / (B03 + B11)**: green B03 is averaged from its four valid 10 m samples onto the native 20 m SWIR B11 grid, then both source calibration scale and offset are applied. Only SCL classes 4, 5 and 6 with valid reflectance and a positive denominator are retained. Cloud, shadow, saturation, snow, unclassified and absent pixels stay unknown. The dates are reprojected independently with nearest-neighbor sampling; overlap uses the first clear same-date granule. The displayed neutral-to-cyan ramp is continuous, with no flood threshold. Higher signal can include ordinary lakes/rivers and other uncertain surfaces. This is not a verified inundation boundary, flood depth, road-access assessment or shelter assessment.

Clear analysis covers **74.23% before Harvey on August 15, 15.30% on August 30, and 32.00% on September 1** of the bounded mapped Houston extent. These are not current-viewport or entire-source-granule percentages. The UI dots unusable observations and explicitly labels pans outside the capture as reference context. Same-date RGB is the source TCI (B04/B03/B02), averaged onto the analysis grid. Color-index WebPs are lossless; paired RGB uses quality 87 with lossless alpha. Companion 16-bit lossless PNGs retain numeric MNDWI: sample zero means no observation; otherwise `(sample − 10001) / 10000`. No analysis is run against rendered WebP pixels.

The Baker Road / Barker example on August 30 uses bbox `[-95.72191,29.74472,-95.69548,29.76780]`; Sentinel has 72.1% clear observations and independent same-day NOAA aerial pixels cover 92.8% of that box. The West Fork San Jacinto / North Houston Avenue example on September 1 uses `[-95.25104,30.00439,-95.22461,30.02748]`. These illustrate measured spectral/visual changes near named roads, without establishing road passability or a verified impact boundary.

`houston-flood-imagery.json` describes **NOAA NGS** true-color emergency-response photographs from five acquisition days, August 30–September 3, 2017. Nine local WebPs (12.8 MB) contain five geographic overviews (~33 m source sampling) and four detail patches (~2.1 m): Addicks and Barker on August 30, Kingwood and San Jacinto on August 31. Every patch has its exact EPSG:4326 extent, acquisition date, original WMTS layer/tile coordinates and hashes. Authentic no-data remains transparent. Flight strips are sparse; a bounding box never implies full historical coverage. NOAA publishes these data under CC0 and reports unassessed horizontal accuracy of approximately 3–5 m in flat areas. Current detail controls do not imply centimeter navigation accuracy.

`houston-radar-imagery.json` contains the original **NASA/JPL ARIA Sentinel-1** probable-inundation indicators for August 29, derived from the August 5/29 radar pair. Twelve georeferenced input granules intersect this map; the cropped 3050 × 2440 image retains 475,468 published indicator pixels and their original blue palette. The nominal proxy sampling is 30 m. Transparent/unmarked pixels mean no proxy indication or unknown status, never dry ground. NASA reports reduced reliability in urban areas. This product is a separate radar estimate, not another optical capture or a definitive flood extent.

Primary descriptions: [Copernicus Sentinel-2 products](https://sentiwiki.copernicus.eu/web/s2-products), [NASA’s B03/B11 MNDWI explanation](https://science.data.nasa.gov/disasters/data-gallery/sentinel-2-mndwi), [NOAA Harvey viewer](https://storms.ngs.noaa.gov/storms/harvey/index.html), [NOAA metadata/CC0/accuracy](https://www.fisheries.noaa.gov/inport/item/59048), and [NASA/JPL’s Sentinel-1 flood-proxy description](https://www.jpl.nasa.gov/images/pia21932-new-nasa-satellite-flood-map-of-southeastern-texas-sentinel-1-data/). The manifests preserve exact asset and catalog URLs. Attribute modified Copernicus Sentinel data (2017), NOAA NGS, NASA/JPL-Caltech/ARIA, and USGS/USDA as appropriate.

### Offline validation

With the existing project Python environment (Pillow, NumPy and Shapely), run `python -m unittest discover -s test -p test_imagery_pyramid.py -v` and `scripts/check_houston_labels.py`. `scripts/prepare_houston_flood_imagery.py --offline-check` also imports Requests. The isolated water preparation environment uses Rasterio 1.4.3, NumPy 2.0.2 and Pillow 11.3.0; run `scripts/prepare_harvey_water.py --check`, `scripts/prepare_harvey_radar.py --check`, and `scripts/check_harvey_water_sources.py --cache-dir SOURCE_CACHE` there. The last command compares 294 delivered pixels directly with cached source COG samples and masks. All checks operate without network when the recorded external source cache is present. Raw COGs, source JPEG/PNG tiles and temporary analysis files stay outside the project and vault; only reviewed rendered products, numeric PNGs and provenance are checked in.


### Native flood-date street detail (November 8 continuation)

Two bounded NOAA zoom-18 crops supplement the existing zoom-12/16 products: Barker/Baker Road on August 30 (4571×4956, ~0.518 m source sampling) and Kingwood/West Fork on August 31 (4660×4951, ~0.517 m). Both crop rectangles have 100% actual source coverage. They are not upscaled zoom-16 images. The eleven products total 17,061,628 bytes; raw source caches stay outside the repository. `prepare_houston_flood_imagery.py --fine-only` rebuilds these crops, and `--offline-check` verifies all product hashes/dimensions/date/coverage/warp constraints. The existing nine products are unchanged.

The open-water index uses the correct Sentinel-2 B03/B11 pair but is not a new-flood classification. In the exact Barker/Baker Road fine rectangle, usable observation coverage is 81.40% on August 15, 71.36% on August 30, and 0% on September 1. In the Kingwood fine rectangle it is 97.61%, 0%, and 76.55%, respectively. These are local pixel-mask checks, distinct from the manifest's full-map fractions. Scene timing and 20 m mixed pixels also matter; optical and NOAA acquisitions must not be treated as simultaneous measurements.


## Viewport observation availability

`houston-observation-coverage.json` is a 592,705-byte offline summary of the three bundled quantitative-index validity masks. Each 4600×3660 registered analysis grid is grouped into 16×16 blocks (288 columns ×229 rows, with smaller edge blocks). An encoded index sample of zero is unavailable; every nonzero sample is observed, including negative and zero MNDWI. This mask is independent of an MNDWI water threshold. Source-manifest and index-file hashes retain provenance.

`python3 scripts/prepare_observation_coverage.py --offline-check` recomputes every count from the existing index PNGs and verifies the output byte-for-byte without writing or requesting a source. The browser uses prefix sums for complete blocks. Partial blocks produce area-weighted estimates plus rigorous lower/upper bounds; these percentages describe registered analysis-grid pixels within the unobscured map rectangle, excluding the open Overview panel and footer. They are not flood extent or a count of independent native sensor samples.

Optical modes distinguish observed, obscured, outside-capture, metadata-unavailable, source-image-error and opacity-zero states. A suggested capture must be available in the active mode, on/after August25, have at least20% conservative coverage, and improve the conservative bound over the current upper bound by more than10 percentage points. No date changes automatically, and a clicked suggestion preserves the camera. This does not infer dry ground, access, welfare, assistance demand or hospitality suitability.
