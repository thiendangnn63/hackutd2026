import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HoustonService } from '../src/houston-service.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'houston-service-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'public/data'); mkdirSync(directory, { recursive: true });
  const put = (name, value) => writeFileSync(join(directory, name), JSON.stringify(value));
  const geometry = { type: 'Polygon', coordinates: [[[-95.8,29.6],[-95.2,29.6],[-95.2,30],[-95.8,30],[-95.8,29.6]]] };
  put('houston-city.json', { type: 'Feature', properties: { name: 'Houston' }, geometry });
  put('houston-neighborhoods.json', { type: 'FeatureCollection', features: ['A','B','C','D'].map(id => ({ type: 'Feature', properties: { id, name: `Test region ${id}` }, geometry })) });
  put('houston-geography-meta.json', { bbox: [-95.8,29.6,-95.2,30], sourceUrls: ['https://example.invalid/test-only'], attribution: 'Test fixture, not geography', basemap: { available: true, file: 'houston-imagery.jpg', bbox: [-95.8,29.6,-95.2,30], date: 'Historical test fixture' } });
  const clusters = ['supplies','evacuation','medical'].map((id,index) => ({ id, regionId: ['A','B','C'][index], imageryId: 'test-flight', imageryDate: '2017-08-30', requestCount: [300,100,2][index], categories: [['supplies'],['evacuation','supplies'],['medical']][index], points: Array.from({ length: [300,100,2][index] }, () => [-95.5,29.8]) }));
  put('houston-demo-placements.json', { schemaVersion:1, fictional:true, crs:'EPSG:4326', clusters, facilities:[{id:'test-facility',type:'supplies',name:'Fictional planning point',resource:'Water',capacity:'20 demo kits',regionId:'A',point:[-95.5,29.8],imageryId:'test-flight',imageryDate:'2017-08-30'}] });
  mkdirSync(join(directory,'flood-imagery'));
  writeFileSync(join(directory,'flood-imagery/test-flight.webp'), 'fictional asset fixture, no decoding');
  writeFileSync(join(directory,'flood-imagery/same-date-other.webp'), 'different fictional asset fixture');
  put('houston-flood-imagery.json', { schemaVersion:1,crs:'EPSG:4326',imagery:[{id:'test-scene',date:'2017-08-30',overview:{id:'test-flight',date:'2017-08-30',crs:'EPSG:4326',bbox:[-95.8,29.6,-95.2,30],path:'/data/flood-imagery/test-flight.webp'},detail:[{id:'same-date-other',date:'2017-08-30',crs:'EPSG:4326',bbox:[-95.8,29.6,-95.2,30],path:'/data/flood-imagery/same-date-other.webp'}]}] });
  return { root, directory, put, service: new HoustonService(root) };
}

test('Houston summary uses verified region files and separates image absence from map availability', t => {
  const f = fixture(t); const result = f.service.view();
  assert.equal(result.available, true); assert.equal(result.mode, 'simulation'); assert.equal(result.city.id, 'houston');
  assert.equal(result.regions.length, 4); assert.equal(result.maxOpenCount, 300);
  assert.equal(result.basemap.available, false); assert.equal(result.basemap.url, null);
  writeFileSync(join(f.directory, 'houston-imagery.jpg'), 'fixture image bytes, never decoded');
  assert.equal(f.service.view().basemap.url, '/data/houston-imagery.jpg');
  assert.equal(f.service.view().basemap.available, true);
});

test('explicit fixture locations and fictional facilities survive the service contract with exact totals', t => {
  const f = fixture(t), result = f.service.view();
  assert.equal(result.fixturePlacement.available, true); assert.equal(result.fixturePlacement.locationSource, 'fictional-fixture');
  assert.deepEqual(result.stats, { openRequests:403, regionsWithReports:3, coverageChecks:1, urgentRequests:1, unlocatedRequests:1 });
  assert.equal(result.regions.reduce((sum, region) => sum + region.requestLocations.length, 0), 402);
  const location = result.regions.find(region => region.id === 'B').requestLocations.find(location => location.id === 'houston-demo-1-0');
  assert.deepEqual(location, { id:'houston-demo-1-0',point:[-95.5,29.8],categories:['evacuation','supplies'],locationSource:'fictional-fixture',imageryId:'test-flight',imageryDate:'2017-08-30' });
  assert.equal(result.facilities[0].point[0], -95.5); assert.equal(result.facilities[0].regionId, 'A'); assert.equal(result.facilities[0].fictional, true); assert.equal(result.facilities[0].operational, false);
  const neighborhoods = JSON.parse(readFileSync(join(f.directory, 'houston-neighborhoods.json')));
  neighborhoods.features.reverse(); f.put('houston-neighborhoods.json', neighborhoods);
  const reversed = f.service.view();
  assert.deepEqual(reversed.regions.find(region => region.id === 'B').requestLocations, result.regions.find(region => region.id === 'B').requestLocations);
  assert.deepEqual(reversed.facilities, result.facilities);
});

test('missing or malformed placements retain geography and raw demand as explicitly unplaced', t => {
  const f = fixture(t);
  for (const missing of [true, false]) {
    if (missing) rmSync(join(f.directory, 'houston-demo-placements.json'));
    else f.put('houston-demo-placements.json', { schemaVersion:1,fictional:false,crs:'EPSG:4326',clusters:[] });
    const result = f.service.view();
    assert.equal(result.available, true); assert.equal(result.fixturePlacement.available, false); assert.match(result.fixturePlacement.reason, /no random locations were substituted/);
    assert.equal(result.stats.openRequests, 403); assert.equal(result.stats.unlocatedRequests, 403); assert.equal(result.maxOpenCount, 0);
    assert.ok(result.regions.every(region => region.requestLocations.length === 0)); assert.deepEqual(result.facilities, []);
    const empty = f.service.view({ scenario:'empty' }); assert.equal(empty.stats.openRequests, 0); assert.equal(empty.fixturePlacement.available, false);
  }
});

test('unregistered image context never supplies request points, while invalid facility points remain reviewable', t => {
  const f = fixture(t), manifest = JSON.parse(readFileSync(join(f.directory, 'houston-demo-placements.json')));
  manifest.facilities[0].point = [-96,31]; f.put('houston-demo-placements.json', manifest);
  let result = f.service.view(); assert.equal(result.fixturePlacement.available, false); assert.equal(result.stats.unlocatedRequests, 1);
  assert.equal(result.facilities[0].point, null); assert.equal(result.facilities[0].locationIssue, 'outside_assigned_region');
  rmSync(join(f.directory, 'houston-flood-imagery.json'));
  result = f.service.view(); assert.equal(result.available, true); assert.equal(result.stats.unlocatedRequests, 403); assert.equal(result.maxOpenCount, 0); assert.equal(result.fixturePlacement.available, false);
});

test('missing exact flood asset leaves its fixtures unplaced even when another same-date image is available', t => {
  const f = fixture(t); assert.equal(f.service.view().fixturePlacement.available, true);
  rmSync(join(f.directory,'flood-imagery/test-flight.webp'));
  assert.ok(readFileSync(join(f.directory,'flood-imagery/same-date-other.webp')).length > 0);
  const result = f.service.view();
  assert.equal(result.available, true); assert.equal(result.fixturePlacement.available, false);
  assert.equal(result.stats.openRequests, 403); assert.equal(result.stats.unlocatedRequests, 403);
  assert.equal(result.maxOpenCount, 0); assert.ok(result.regions.every(region => region.requestLocations.length === 0));
  assert.equal(result.facilities[0].point, null); assert.equal(result.facilities[0].locationIssue, 'unknown_imagery_reference');
  assert.equal(result.facilities[0].imageryId, 'test-flight');
});

test('per-asset image date and CRS are not borrowed from a containing scene', t => {
  const f = fixture(t), manifest = JSON.parse(readFileSync(join(f.directory,'houston-flood-imagery.json')));
  manifest.imagery[0].overview.date = '2017-09-01'; f.put('houston-flood-imagery.json',manifest);
  assert.equal(f.service.view().stats.unlocatedRequests, 403);
  manifest.imagery[0].overview.date = '2017-08-30'; manifest.imagery[0].overview.crs = 'EPSG:3857'; f.put('houston-flood-imagery.json',manifest);
  assert.equal(f.service.view().stats.unlocatedRequests, 403);
});

test('malformed historical image registration cannot remove verified city geography', t => {
  const f = fixture(t), manifest = JSON.parse(readFileSync(join(f.directory,'houston-flood-imagery.json')));
  manifest.imagery[0].detail = {}; f.put('houston-flood-imagery.json',manifest);
  const result = f.service.view(); assert.equal(result.available, true); assert.equal(result.fixturePlacement.available, false);
  assert.equal(result.stats.unlocatedRequests, 403); assert.equal(result.maxOpenCount, 0);
});

test('bundled manifest places exact demand only in stable covered-region IDs', () => {
  const result = new HoustonService(new URL('..', import.meta.url).pathname).view();
  assert.equal(result.available, true); assert.equal(result.fixturePlacement.available, true);
  assert.deepEqual(result.stats, { openRequests:403, regionsWithReports:3, coverageChecks:86, urgentRequests:1, unlocatedRequests:1 });
  assert.deepEqual(result.regions.filter(region => region.openCount).map(region => [region.id,region.openCount]), [['houston-sn-09',2],['houston-sn-17',300],['houston-sn-43',100]]);
  assert.equal(result.facilities.length, 6); assert.ok(result.facilities.every(facility => facility.point && facility.operational === false));
});

test('empty scenario preserves every coverage area with finite zero intensity', t => {
  const f = fixture(t); const result = f.service.view({ scenario: 'empty' });
  assert.equal(result.maxOpenCount, 0); assert.equal(result.stats.openRequests, 0);
  assert.equal(result.queue.length, 4);
  assert.ok(result.regions.every(region => region.intensity === 0 && region.coverageStatus === 'unknown'));
});

test('other cities and unsupported scenarios are rejected instead of substituted', t => {
  const { service } = fixture(t);
  for (const input of [{ city: 'pasadena' }, { city: '../houston' }, { scenario: 'live' }]) assert.throws(() => service.view(input), error => error.status === 400);
});

test('missing or invalid official geometry never produces pretend boundaries or counts', t => {
  const f = fixture(t); f.put('houston-city.json', { type: 'Feature', geometry: null });
  assert.equal(f.service.view().available, false); assert.equal(f.service.view().regions, undefined);
  rmSync(join(f.directory, 'houston-city.json'));
  assert.equal(f.service.view().available, false);
});

test('Houston API rejects foreign cities and origins and does not mutate family state', async t => {
  const f = fixture(t); const store = new Store(); const before = store.read();
  const app = createApp(store, undefined, f.service);
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.close(resolve)));
  const base = `http://127.0.0.1:${app.address().port}`;
  const normal = await fetch(base + '/api/houston'); assert.equal(normal.status, 200);
  const normalBody = await normal.json(); assert.equal(normalBody.maxOpenCount, 300);
  assert.equal(normalBody.regions.reduce((sum,region) => sum + region.requestLocations.length, 0), 402);
  assert.equal(normalBody.facilities[0].operational, false);
  const empty = await fetch(base + '/api/houston?scenario=empty'); assert.equal((await empty.json()).stats.openRequests, 0);
  for (const query of ['?city=pasadena', '?scenario=live', '?path=../secrets']) assert.equal((await fetch(base + '/api/houston' + query)).status, 400);
  assert.equal((await fetch(base + '/api/houston', { headers: { origin: 'https://unrelated.invalid' } })).status, 403);
  assert.deepEqual(store.read(), before);
});

test('historical context imagery exposes only existing allowlisted EPSG4326 rasters and does not broaden request geometry',t=>{
  const f=fixture(t);
  const context={id:'earth',file:'earth-context.jpg',available:true,crs:'EPSG:4326',bbox:[-180,-90,180,90],kind:'world',date:'Historical August 2004 composite'};
  const base={bbox:[-95.8,29.6,-95.2,30],contextBasemaps:[context]};
  f.put('houston-geography-meta.json',base);
  let result=f.service.view();assert.equal(result.available,true);assert.equal(result.contextBasemaps[0].available,false);assert.equal(result.contextBasemaps[0].url,null);
  writeFileSync(join(f.directory,context.file),'fixture bytes; no image decoding in service');
  result=f.service.view();assert.equal(result.contextBasemaps[0].available,true);assert.equal(result.contextBasemaps[0].url,'/data/earth-context.jpg');
  assert.deepEqual(result.city.bbox,base.bbox);assert.equal(result.regions.length,4);assert.equal(result.maxOpenCount,300);
  const invalid=[{...context,file:'../../.env'},{...context,crs:'EPSG:3857'},{...context,bbox:[-200,-90,180,90]},{...context,bbox:[0,0,0,1]},{...context,bbox:[-180,-90,NaN,90]}];
  for(const image of invalid){f.put('houston-geography-meta.json',{...base,contextBasemaps:[image]});const next=f.service.view();assert.equal(next.available,true);assert.equal(next.contextBasemaps[0].available,false);assert.equal(next.contextBasemaps[0].url,null);}
});

test('context metadata absence remains compatible with boundary-only fixtures',t=>{
  const f=fixture(t),result=f.service.view();assert.deepEqual(result.contextBasemaps,[]);assert.equal(result.basemap.available,false);
});

test('bundled geographic context assets have exact local image routes without arbitrary file access',async t=>{
  const f=fixture(t),store=new Store(),app=createApp(store,undefined,f.service);
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>app.close(resolve)));
  const base=`http://127.0.0.1:${app.address().port}`;
  for(const filename of ['earth-context.jpg','houston-context.jpg','houston-metro.png']){
    const response=await fetch(`${base}/data/${filename}`);assert.equal(response.status,200);
    assert.equal(response.headers.get('content-type'),filename.endsWith('.png')?'image/png':'image/jpeg');
    const bytes=new Uint8Array(await response.arrayBuffer());assert.deepEqual([...bytes.slice(0,2)],filename.endsWith('.png')?[137,80]:[255,216]);
  }
  assert.equal((await fetch(`${base}/data/context-arbitrary.jpg`)).status,404);
});

function pyramidFixture(t){
  const f=fixture(t),tile={id:'naip-l0-r00-c00',file:'naip-l0-r00-c00.webp',bbox:[-95.8,29.6,-95.2,30],width:2048,height:2048,metersPerPixel:20,available:true,bytes:16};
  const fine={...tile,id:'naip-l3-r00-c00',file:'naip-l3-r00-c00.webp',metersPerPixel:2.7};
  const manifest={schemaVersion:1,crs:'EPSG:4326',bbox:[-95.8,29.6,-95.2,30],downloading:true,historical:true,date:'Historical fixture',tiers:[
    {id:'naip-4k',level:0,metersPerPixel:20,tiles:[tile]},
    {id:'naip-32k',level:3,metersPerPixel:2.7,tiles:[fine]}
  ]};
  f.put('houston-imagery-pyramid.json',manifest);mkdirSync(join(f.directory,'imagery'));
  const bytes=Buffer.from('RIFFfixtureWEBP');writeFileSync(join(f.directory,'imagery',tile.file),bytes);
  return {...f,tile,fine,manifest,bytes};
}

test('detail manifest advertises only local existing allowlisted tiles and preserves progressive gaps',t=>{
  const f=pyramidFixture(t),p=f.service.imageryPyramid();
  assert.equal(p.available,true);assert.equal(p.complete,false);assert.equal(p.downloading,true);assert.equal(p.stats.totalTiles,2);assert.equal(p.stats.availableTiles,1);
  assert.equal(p.tiers[0].tiles[0].url,'/data/imagery/naip-l0-r00-c00.webp');
  assert.equal(p.tiers[1].tiles[0].available,false);assert.equal(p.tiers[1].tiles[0].url,null);
  assert.equal(f.service.view().imageryPyramid.stats.availableTiles,1);assert.deepEqual(f.service.imageryTile(f.tile.file),f.bytes);
  assert.throws(()=>f.service.imageryTile(f.fine.file),error=>error.status===404);
  for(const name of ['../.env','../../state.json','naip-l4-r00-c00.webp','unknown.webp'])assert.throws(()=>f.service.imageryTile(name),error=>error.status===404);
});

test('invalid detail geometry or manifest never replaces verified city geometry or exposes arbitrary files',t=>{
  const f=pyramidFixture(t);
  for(const bad of [{...f.tile,file:'../../.env'},{...f.tile,bbox:[-200,29,-95,30]},{...f.tile,bbox:[-96,29,-95,30]},{...f.tile,width:0}]){
    f.put('houston-imagery-pyramid.json',{...f.manifest,tiers:[{...f.manifest.tiers[0],tiles:[bad]}]});
    assert.equal(f.service.imageryPyramid().available,false);assert.equal(f.service.view().available,true);
  }
  f.put('houston-imagery-pyramid.json',{...f.manifest,crs:'EPSG:3857'});assert.equal(f.service.imageryPyramid().available,false);assert.equal(f.service.view().regions.length,4);
  rmSync(join(f.directory,'houston-imagery-pyramid.json'));assert.deepEqual(f.service.imageryPyramid().tiers,[]);assert.equal(f.service.view().available,true);
});

test('detail HTTP endpoints remain read-only and reject unlisted or missing imagery paths',async t=>{
  const f=pyramidFixture(t),store=new Store(),before=store.read(),app=createApp(store,undefined,f.service);
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>app.close(resolve)));
  const base=`http://127.0.0.1:${app.address().port}`;
  const manifest=await fetch(base+'/api/houston/imagery');assert.equal(manifest.status,200);assert.equal((await manifest.json()).stats.availableTiles,1);
  assert.equal((await fetch(base+'/api/houston/imagery?path=../.env')).status,400);
  const tile=await fetch(base+'/data/imagery/'+f.tile.file);assert.equal(tile.status,200);assert.equal(tile.headers.get('content-type'),'image/webp');assert.deepEqual(Buffer.from(await tile.arrayBuffer()),f.bytes);
  for(const filename of [f.fine.file,'naip-l0-r99-c99.webp','../.env'])assert.equal((await fetch(base+'/data/imagery/'+filename)).status,404);
  assert.deepEqual(store.read(),before);
});


test('rejected detail entries cannot make an otherwise partial pyramid appear complete',t=>{
  const f=pyramidFixture(t);
  f.put('houston-imagery-pyramid.json',{...f.manifest,tiers:[{...f.manifest.tiers[0],tiles:[f.tile,{...f.fine,file:'../../.env'}]}]});
  const p=f.service.imageryPyramid();assert.equal(p.available,true);assert.equal(p.complete,false);assert.equal(p.stats.totalTiles,2);assert.equal(p.stats.validatedTiles,1);assert.equal(p.stats.rejectedTiles,1);assert.equal(p.stats.availableTiles,1);
});
