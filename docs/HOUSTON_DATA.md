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
