import test from 'node:test';
import assert from 'node:assert/strict';
import {geometryBounds,insideGeometry,hasIntersection,demoLocations,buildSubtiles,hospitalityFixture,hospitalityForRegion,NEED_TYPES,detailLevel,cameraView,zoomAt} from '../public/map-model.js';
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
