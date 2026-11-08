#!/usr/bin/env python3
"""Prepare offline Houston GIS assets. Requires shapely; no app runtime dependency.
Run with --cache-dir /tmp/houston-source to reuse downloaded source GeoJSON.
All requests are read-only public GIS requests; no account, key, or paid service.
"""
import argparse, datetime, json, pathlib, urllib.parse, urllib.request
from shapely.geometry import shape, mapping, Polygon, MultiPolygon
from shapely.ops import unary_union

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / 'public/data'
GIS = 'https://mapsop1.houstontx.gov/arcgis/rest/services/CAS/CASMapViewer/MapServer'
IMAGE = 'https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer'

def fetch(url, params=None):
    if params: url += '?' + urllib.parse.urlencode(params)
    with urllib.request.urlopen(url, timeout=180) as response: return response.read()

def get_json(url, params=None):
    data = json.loads(fetch(url, params))
    if 'error' in data: raise RuntimeError(data['error'])
    return data

def write(name, value):
    (OUT / name).write_text(json.dumps(value, separators=(',', ':')) + '\n')

def polygonal(g):
    if not g.is_valid: g = g.buffer(0)
    if isinstance(g, (Polygon, MultiPolygon)): return g
    return unary_union([p for p in g.geoms if isinstance(p, (Polygon, MultiPolygon))])

def feature(g, id, name, **props):
    return {'type':'Feature','id':id,'properties':{'id':id,'name':name,**props}, 'geometry':mapping(g)}

def main():
    parser = argparse.ArgumentParser(); parser.add_argument('--cache-dir', type=pathlib.Path); parser.add_argument('--skip-imagery',action='store_true'); args=parser.parse_args()
    OUT.mkdir(exist_ok=True,parents=True)
    sources={}
    for n in [2,3]:
        cached = args.cache_dir / f'{n}.json' if args.cache_dir else None
        sources[n] = json.loads(cached.read_text()) if cached and cached.exists() else get_json(f'{GIS}/{n}/query',dict(where='1=1',outFields='*',returnGeometry='true',outSR=4326,f='geojson'))
        if sources[n].get('exceededTransferLimit'): raise RuntimeError('Source response was truncated')
    # FULL city only. LIMITED service/tax districts are not residential city limits.
    city = polygonal(unary_union([shape(f['geometry']) for f in sources[2]['features'] if f['properties']['SERVICE_TY']=='FULL' and f['properties']['ENTITY_NAM']=='CITY OF HOUSTON']))
    bbox=list(city.bounds)
    cf=feature(city,'houston','Houston',kind='city',boundaryScope='full-purpose city limits')
    cf['bbox']=bbox; write('houston-city.json',cf)
    features=[]; covered=Polygon()
    for f in sorted(sources[3]['features'],key=lambda f:f['properties']['POLYID']):
        p=f['properties']; number=int(p['POLYID']); g=polygonal(shape(f['geometry']))
        # Keep official outlines intact: no simplification, rounding or lost exclaves.
        g=polygonal(g.intersection(city).difference(covered))
        if g.is_empty: continue
        point=g.representative_point()
        features.append(feature(g,f'houston-sn-{number:02d}',p['SNBNAME'].title(),kind='super-neighborhood',superNeighborhoodNumber=number,labelPoint=[point.x,point.y],sourceName=p['SNBNAME']))
        covered=unary_union([covered,g])
    remainder=polygonal(city.difference(covered))
    if not remainder.is_empty:
        point=remainder.representative_point()
        features.append(feature(remainder,'houston-coverage-remainder','Houston coverage areas',kind='coverage-remainder',labelPoint=[point.x,point.y],description='Full-purpose Houston land outside the source Super Neighborhood polygons; includes annexation corridors and boundary gaps. Not an official neighborhood.'))
    all_areas=unary_union([shape(f['geometry']) for f in features])
    checks={'featureCount':len(features),'officialNeighborhoodCount':len(features)-int(not remainder.is_empty),'outsideCityAreaDegreesSquared':all_areas.difference(city).area,'uncoveredCityAreaDegreesSquared':city.difference(all_areas).area,'overlapAreaDegreesSquared':sum(shape(f['geometry']).area for f in features)-all_areas.area,'cityGeometryValid':city.is_valid,'allFeaturesValid':all(shape(f['geometry']).is_valid for f in features)}
    assert checks['outsideCityAreaDegreesSquared']<1e-12 and checks['uncoveredCityAreaDegreesSquared']<1e-12 and abs(checks['overlapAreaDegreesSquared'])<1e-12
    write('houston-neighborhoods.json',{'type':'FeatureCollection','bbox':bbox,'features':features})
    meta={'schemaVersion':1,'cityName':'Houston','regionDescription':'88 official Super Neighborhoods plus full-purpose Houston coverage remainder','sourceUrls':[GIS+'/2',GIS+'/3',IMAGE],'basemap':{'available':False},'retrievedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'crs':'EPSG:4326','bbox':bbox,'cityFile':'/data/houston-city.json','neighborhoodsFile':'/data/houston-neighborhoods.json','boundarySource':GIS+'/2','neighborhoodSource':GIS+'/3','boundaryScope':'FULL City of Houston only; excludes limited-purpose service/tax districts and ETJ','boundaryDate':'Current public service snapshot at retrieval; effective vintage not supplied for main city polygon','geometryProcessing':'Source precision preserved; polygon validity repaired if needed; neighborhoods intersected with city and earlier numbered neighborhoods to remove overlaps; uncovered city area retained as explicit coverage remainder. No simplification.','attribution':'City of Houston, Houston Public Works / Planning and Development Department; USGS, USDA, The National Map','checks':checks,'imagery':{'available':False}}
    print(json.dumps(checks),flush=True)
    write('houston-geography-meta.json',meta)
    if not args.skip_imagery:
        params=dict(bbox=','.join(map(str,bbox)),bboxSR=4326,imageSR=4326,size='1200,900',format='jpg',compressionQuality=85,adjustAspectRatio='false',f='json')
        export=get_json(IMAGE+'/exportImage',params)
        image_bytes=fetch(export['href'])
        if not image_bytes.startswith(b'\xff\xd8'): raise RuntimeError('Export is not JPEG')
        (OUT/'houston-imagery.jpg').write_bytes(image_bytes)
        ext=export['extent']; bounds=[ext[k] for k in ['xmin','ymin','xmax','ymax']]
        meta['imagery']={'available':True,'file':'/data/houston-imagery.jpg','bounds':bounds,'crs':'EPSG:4326','width':export['width'],'height':export['height'],'source':IMAGE,'exportEndpoint':IMAGE+'/exportImage','exportParameters':params,'attribution':'USGS, USDA, The National Map: Orthoimagery','license':'Public domain NAIP aerial imagery, as described by USGS service','historical':True,'acquisitionDate':'Historical mosaic; per-pixel acquisition dates not available in export. Not live or disaster-specific imagery.','serviceCopyrightText':get_json(IMAGE,{'f':'json'}).get('copyrightText'),'maskRequired':True}
        meta['basemap']={'available':True,'file':'houston-imagery.jpg','bbox':bounds,'attribution':'USGS, USDA, The National Map','date':'Historical NAIP aerial imagery; capture date varies','sourceUrl':IMAGE,'license':'Public domain NAIP aerial imagery','width':export['width'],'height':export['height'],'crs':'EPSG:4326'}
        write('houston-geography-meta.json',meta)
        print('Imagery saved',len(image_bytes),'bytes',bounds,flush=True)

if __name__=='__main__': main()
