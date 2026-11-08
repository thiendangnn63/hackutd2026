# Covered fictional planning locations

The map's 402 located requests and six planning facilities use explicit, stable
fictional coordinates within Houston's official boundary and their assigned
Super Neighborhood. The separate unknown-location request remains unplaced:
403 open requests total. Placed categories remain 400 supplies, 100 evacuation,
2 medical and 0 other; categories overlap. Hospitality scores and the Oak District
family welfare workflow remain independent.

| Cluster | Region | Historical NOAA context |
| --- | --- | --- |
| 300 fictional supplies requests | houston-sn-17 · Eldridge / West Oaks | harvey-20170830-barker · August 30, 2017 · approximately 2.07 m/pixel |
| 100 fictional evacuation/supplies requests | houston-sn-43 · Kingwood Area | harvey-20170831-kingwood · August 31, 2017 · approximately 2.07 m/pixel |
| 2 fictional medical requests | houston-sn-09 · Addicks Park Ten | harvey-20170830-addicks · August 30, 2017 · approximately 2.07 m/pixel |

The small built patches in `public/data/houston-demo-placements.json` were checked
visually against bundled NOAA imagery. Reservoir woodland in the smaller native
0.5 m crops was not used to simulate hundreds of neighborhood reports. Every
request/facility point also passes official city/region containment and fully
opaque source alpha throughout a 5×5 pixel neighborhood. Source image and
geometry checksums are recorded in the manifest. Alpha establishes image
availability; it does not classify floodwater, dry ground or safety.

All people, reports, facility roles and capacities are invented. No real business
or building is asserted to operate as a shelter, medical point or supply center.
NOAA context is dated historical imagery, not the date or source of actual
emergency reports. Use the explicit **View flood imagery** action in area or
facility details to choose the matching available NOAA capture and fit the
fictional locations. Background loading does not move the map.

The backend exposes canonical `region.requestLocations` and top-level
`facilities` with `regionId`, `point`, `imageryId`, `imageryDate` and
`locationSource:'fictional-fixture'`. The browser uses those points directly at
every subdivision level. Invalid explicit locations remain unplaced and are
never regenerated at a region centroid or random replacement position.

Regenerate or verify locally with Pillow installed:

```sh
python3 scripts/prepare_houston_demo_placements.py
python3 scripts/prepare_houston_demo_placements.py --check
```

The generator reads only bundled files and makes no network or model calls.
