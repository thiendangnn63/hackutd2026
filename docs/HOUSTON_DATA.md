# Houston geography and historical aerial basemap

These files are geographic context for a fictional local exercise, not emergency navigation or evidence of disaster damage. No real resident information is included. Sources were retrieved on 2026-11-08 UTC.

## Asset contract

- `public/data/houston-city.json`: WGS84/EPSG:4326 GeoJSON **Feature**, ID `houston`, with full-purpose Houston city geometry and `[west,south,east,north]` bbox.
- `public/data/houston-neighborhoods.json`: GeoJSON **FeatureCollection**, 88 official Super Neighborhoods plus one explicit coverage-remainder feature (89 total). Every feature has identical top-level `id` and `properties.id`, `properties.name`, `properties.kind` and an interior `properties.labelPoint` `[longitude,latitude]`. Official IDs are `houston-sn-01` through `houston-sn-88`, based on the City's stable `POLYID`. `houston-coverage-remainder` is a derived coverage area, not an official neighborhood. Its disconnected components include annexation corridors and mismatches between the two official layers. Do not omit it from zero-report review.
- `public/data/houston-geography-meta.json`: `cityName`, `regionDescription`, `bbox`, `sourceUrls`, `attribution`, `basemap` plus detailed processing, validation and image provenance. `basemap.file` is relative to `/data/`; `basemap.bbox` is the **returned export extent**, not an assumed matching extent.
- `public/data/houston-imagery.jpg`: historical USGS/USDA NAIP natural-color aerial mosaic, when `basemap.available` is true. This is an aerial image, not a current satellite observation.

Coordinates are longitude/latitude. Use a linear longitude/latitude map projection for both SVG paths and the EPSG:4326 image. Position the image from `basemap.bbox`. Clip **the image, polygons and interaction hit regions** to the city Feature, respecting interior holes using even-odd fill/clip rules. Never substitute a rectangular city selection boundary. No surrounding towns should be visible or selectable; contained independent municipalities remain holes. Retain the entire extent including western annexation corridors, Kingwood and Clear Lake.

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
