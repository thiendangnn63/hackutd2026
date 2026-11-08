import test from 'node:test';
import assert from 'node:assert/strict';
import {boundCameraToExtent,searchMapRecords,geometryBounds,insideGeometry,hasIntersection,demoLocations,buildSubtiles,hospitalityFixture,hospitalityForRegion,NEED_TYPES,detailLevel,cameraView,zoomAt} from '../public/map-model.js';
import {HoustonService} from '../src/houston-service.js';
const root=new URL('..',import.meta.url).pathname;
const square={type:'Polygon',coordinates:[[[0,0],[4,0],[4,4],[0,4],[0,0]],[[1,1],[3,1],[3,3],[1,3],[1,1]]]};
test('geometry containment respects holes and disconnected polygons',()=>{
  assert.equal(insideGeometry([.5,.5],square),true);assert.equal(insideGeometry([2,2],square),false);
  assert.equal(insideGeometry([9,9],square),false);assert.deepEqual(geometryBounds(square),[0,0,4,4]);
  assert.equal(insideGeometry([.5,.5],{type:'MultiPolygon',coordinates:[square.coordinates]}),true);
});
test('every synthesized Houston report lies inside its real region, with no dropped requests',()=>{
  const data=new HoustonService(root).view();assert.equal(data.available,true);
  for(const region of data.regions){
    const locations=demoLocations(region);assert.equal(locations.length,region.openCount);
    for(const l of locations)assert.ok(l.point&&insideGeometry(l.point,region.geometry),region.name);
    for(const level of [1,2]){
      const cells=buildSubtiles(region,level,locations);
      assert.ok(cells.every(c=>!c.openCount||c.hasArea));
      assert.equal(cells.reduce((s,c)=>s+c.openCount,0),region.openCount,`${region.name}: level ${level}`);
      for(const category of NEED_TYPES)assert.equal(cells.reduce((s,c)=>s+c.categories[category],0),region.categories[category]);
    }
  }
});
test('subdivision is deterministic, conserves overlapping categories, and never mutates inputs',()=>{
  const region={id:'ring',geometry:square,openCount:101,categories:{medical:101,evacuation:50,supplies:91,other:0}};
  const before=structuredClone(region),locations=demoLocations(region);
  assert.deepEqual(locations,demoLocations(region));
  const cells=buildSubtiles(region,2,locations);assert.equal(cells.length,16);
  assert.equal(cells.reduce((s,c)=>s+c.categories.supplies,0),91);
  assert.equal(cells.reduce((s,c)=>s+c.categories.evacuation,0),50);assert.deepEqual(region,before);
});
test('zero-report cells remain zero while hospitality stays independent of report volume',()=>{
  const region={id:'empty',geometry:square,openCount:0,categories:{}};
  for(const c of buildSubtiles(region,2))assert.equal(c.openCount,0);
  const h=hospitalityFixture('abc');assert.deepEqual(h,hospitalityFixture('abc'));
  if(h.score!==null)assert.equal(h.score,Math.round((+h.power + +h.water + +h.access)/3*100));
});
test('detail levels follow zoom and camera fills either viewport aspect ratio',()=>{
  assert.equal(detailLevel(1),0);assert.equal(detailLevel(2.2),1);assert.equal(detailLevel(5),2);
  for(const [w,h]of [[1440,900],[390,650]]){const v=cameraView({x:400,y:315,zoom:2},w,h);assert.ok(Math.abs(v.width/v.height-w/h)<1e-12);assert.equal(v.x+v.width/2,400);assert.equal(v.y+v.height/2,315);}
  const c=zoomAt({x:400,y:315,zoom:1},2,{x:100,y:100});assert.equal((100-c.x)*c.zoom,(100-400));assert.equal((100-c.y)*c.zoom,(100-315));
});

test('empty or hole-only cells are excluded from map interaction',()=>{assert.equal(hasIntersection([1.2,1.2,2.8,2.8],square),false);assert.equal(hasIntersection([5,5,6,6],square),false);assert.equal(hasIntersection([0,0,.5,.5],square),true);});

const rect=(w,s,e,n)=>[[[w,s],[e,s],[e,n],[w,n],[w,s]]];
const twoAreas={type:'MultiPolygon',coordinates:[rect(0,0,1,1),rect(3.5,3.5,4,4)]};

test('hospitality capacity is conserved from fixed finest fixtures at all zoom levels',()=>{
  const region={id:'mixed',name:'Mixed region',geometry:{type:'Polygon',coordinates:rect(0,0,4,4)}};
  const finest=hospitalityForRegion(region,2),knownCapacity=finest.reduce((sum,c)=>sum+(c.hospitality.capacity??0),0);
  for(const level of [0,1,2]){
    const cells=hospitalityForRegion(region,level);
    assert.equal(cells.length,4**level);
    assert.equal(cells.reduce((sum,c)=>sum+(c.hospitality.capacity??0),0),knownCapacity);
    assert.equal(cells.reduce((sum,c)=>sum+c.hospitality.knownArea,0),finest.reduce((sum,c)=>sum+c.hospitality.knownArea,0));
    for(const cell of cells){
      const leaves=finest.filter(f=>f.bounds[0]>=cell.bounds[0]&&f.bounds[2]<=cell.bounds[2]&&f.bounds[1]>=cell.bounds[1]&&f.bounds[3]<=cell.bounds[3]);
      assert.equal(cell.hospitality.capacity,leaves.some(f=>f.hospitality.capacity!==null)?leaves.reduce((sum,f)=>sum+(f.hospitality.capacity??0),0):null);
    }
  }
});

test('hospitality scores use clipped area weights instead of averaging unequal land cells',()=>{
  const region={id:'weighted',name:'Unequal areas',geometry:twoAreas};
  const finest=hospitalityForRegion(region,2).filter(c=>c.hasArea),parent=hospitalityForRegion(region)[0].hospitality;
  assert.equal(finest.length,2);assert.equal(parent.totalArea,1.25);
  assert.equal(parent.score,60); // (67 × 1 + 33 × .25) / 1.25, rounded.
  assert.equal(parent.capacity,81+69);assert.equal(parent.coverage,100);
  assert.equal(parent.power,true);assert.equal(parent.water,false);assert.equal(parent.access,null);
  assert.deepEqual(parent.utilityCoverage.access,{available:80,unavailable:20,unknown:0});
});

test('unknown hospitality is not zero suitability or available capacity and partial coverage is explicit',()=>{
  const unknown={id:'unknown-0',name:'Unknown areas',geometry:twoAreas};
  const allUnknown=hospitalityForRegion(unknown)[0].hospitality;
  assert.equal(allUnknown.score,null);assert.equal(allUnknown.capacity,null);
  assert.equal(allUnknown.coverage,0);assert.equal(allUnknown.unknownCoverage,100);assert.equal(allUnknown.coverageState,'unknown');
  for(const key of ['power','water','access']){assert.equal(allUnknown[key],null);assert.deepEqual(allUnknown.utilityCoverage[key],{available:0,unavailable:0,unknown:100});}
  const partial=hospitalityForRegion({id:'mixed',name:'Mixed region',geometry:{type:'Polygon',coordinates:rect(0,0,4,4)}})[0].hospitality;
  assert.equal(partial.coverage,87.5);assert.equal(partial.unknownCoverage,12.5);assert.equal(partial.coverageState,'partial');
  assert.equal(partial.score,50);assert.equal(partial.power,null);
  assert.equal(partial.utilityCoverage.power.available,50);assert.equal(partial.utilityCoverage.power.unknown,12.5);
});

test('hospitality hierarchy is deterministic, independent of request volume, and does not mutate or alias inputs',()=>{
  const region={id:'mixed',name:'Mixed region',geometry:square,openCount:9,categories:{supplies:9}},before=structuredClone(region);
  for(const level of [0,1,2]){
    const expected=hospitalityForRegion(region,level),again=hospitalityForRegion(region,level);
    assert.deepEqual(expected,again);assert.deepEqual(expected,hospitalityForRegion({...region,openCount:1000,categories:{medical:1000}},level));
    const subtiles=buildSubtiles(region,level);
    assert.deepEqual(subtiles.map(c=>c.hospitality),expected.map(c=>c.hospitality));
    expected[0].hospitality.utilityCoverage.power.available=-1;
    assert.notEqual(hospitalityForRegion(region,level)[0].hospitality.utilityCoverage.power.available,-1);
  }
  assert.deepEqual(region,before);
});


const mapRegions=[
  {id:'willow',name:'Willowbrook',geometry:{type:'Polygon',coordinates:rect(0,0,4,4)},notes:'water hub'},
  {id:'north',name:'North District',geometry:{type:'Polygon',coordinates:rect(4,0,8,4)}}
];
const mapPlaces=[
  {id:'supplies-north',name:'Northside distribution hub',resource:'Water & essential supplies',type:'supplies',region:mapRegions[1],status:'unverified'},
  {id:'shelter-west',name:'West community shelter',resource:'Temporary hospitality',type:'shelter',region:mapRegions[0],status:'unverified'},
  {id:'medical-central',name:'Central medical point',resource:'Medical assessment & drinking water',type:'medical',region:mapRegions[0],status:'unverified'}
];

test('global map search returns no fallback rows for empty or unmatched queries',()=>{
  for(const query of ['', '  \t  ', 'no-such-person-or-place'])assert.deepEqual(searchMapRecords(mapRegions,mapPlaces,query),{regions:[],places:[]});
  assert.deepEqual(searchMapRecords(mapRegions,mapPlaces,'water').regions,[]); // Region notes are not a geographic name.
});

test('global map search ANDs name, resource, type and neighborhood terms independently of word order',()=>{
  assert.deepEqual(searchMapRecords(mapRegions,mapPlaces,'north water supplies').places.map(p=>p.id),['supplies-north']);
  assert.deepEqual(searchMapRecords(mapRegions,mapPlaces,'water NORTH').places.map(p=>p.id),['supplies-north']);
  assert.deepEqual(searchMapRecords(mapRegions,mapPlaces,'willowbrook medical assessment').places.map(p=>p.id),['medical-central']);
  assert.deepEqual(searchMapRecords(mapRegions,mapPlaces,'water shelter').places,[]);
  assert.deepEqual(searchMapRecords(mapRegions,mapPlaces,'DISTRICT north').regions.map(r=>r.id),['north']);
});

test('global map search handles accents, whitespace and punctuation as literal text',()=>{
  const regions=[{id:'unicode',name:'Clínica Ñorte'},{id:'literal',name:'Café (A+B) [North]'},{id:'regex-other',name:'AxB'}];
  assert.equal(searchMapRecords(regions,[],'CLINICA   norte').regions[0].id,'unicode');
  assert.deepEqual(searchMapRecords(regions,[],'a+b').regions.map(r=>r.id),['literal']);
  assert.equal(searchMapRecords(regions,[],'[north]').regions[0].id,'literal');
  assert.deepEqual(searchMapRecords(regions,[],'a.b').regions,[]);
  assert.deepEqual(searchMapRecords([{id:'literal-html',name:'<script>Named region</script>'}],[],'<script>').regions.map(r=>r.id),['literal-html']);
});

test('global map search honors enabled facility types without hiding matching regions',()=>{
  const result=searchMapRecords(mapRegions,mapPlaces,'willowbrook',{enabledTypes:['supplies']});
  assert.equal(result.regions[0],mapRegions[0]);assert.deepEqual(result.places,[]);
  assert.deepEqual(searchMapRecords(mapRegions,mapPlaces,'water',{enabledTypes:[]}).places,[]);
  assert.deepEqual(searchMapRecords(mapRegions,mapPlaces,'water',{enabledTypes:['medical']}).places.map(p=>p.id),['medical-central']);
});

test('global map search ranks exact, prefix, name terms and context while preserving tie order',()=>{
  const regionNames=['Greater North Center','North Center','North','North Annex','North'];
  const regions=regionNames.map((name,i)=>({id:`r${i}`,name}));
  assert.deepEqual(searchMapRecords(regions,[],'north').regions.map(r=>r.id),['r2','r4','r1','r3','r0']);
  const places=[
    {id:'context-first',name:'Supply depot',resource:'North district',type:'supplies'},
    {id:'name-terms',name:'Greater North Center',type:'supplies'},
    {id:'prefix-first',name:'North Center',type:'medical'},
    {id:'exact',name:'North',type:'shelter'},
    {id:'prefix-second',name:'North Annex',type:'supplies'},
    {id:'context-second',name:'Medical tent',type:'medical',region:{name:'North District'}}
  ];
  assert.deepEqual(searchMapRecords([],places,'north').places.map(p=>p.id),['exact','prefix-first','prefix-second','name-terms','context-first','context-second']);
});

test('global map search leaves geometry, facility status, array order and caller state untouched',()=>{
  const state={regions:structuredClone(mapRegions),places:structuredClone(mapPlaces),scenario:'normal'},before=structuredClone(state);
  const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);Object.values(value).forEach(freeze);}};freeze(state);
  const result=searchMapRecords(state.regions,state.places,'water');
  assert.deepEqual(state,before);assert.notEqual(result.regions,state.regions);assert.notEqual(result.places,state.places);
  assert.equal(result.places[0],state.places[0]);assert.equal(result.places[1],state.places[2]);
  assert.ok(result.places.every(p=>p.status==='unverified'));
});


test('raster coverage bounds limit pan to real imagery without repeating map geography',()=>{
  const extent={x:-10000,y:-5000,width:20000,height:10000},camera={x:999999,y:-999999,zoom:.2};
  const fitted=boundCameraToExtent(camera,extent,2560,720),view=cameraView(fitted,2560,720);
  assert.equal(fitted.zoom,camera.zoom);assert.ok(view.x>=extent.x);assert.ok(view.y>=extent.y);
  assert.ok(view.x+view.width<=extent.x+extent.width);assert.ok(view.y+view.height<=extent.y+extent.height);
  assert.deepEqual(camera,{x:999999,y:-999999,zoom:.2});
  assert.deepEqual(boundCameraToExtent({x:100,y:100,zoom:1},{x:0,y:0,width:100,height:100},800,630),{x:50,y:50,zoom:1});
});
