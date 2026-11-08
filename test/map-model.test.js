import test from 'node:test';
import assert from 'node:assert/strict';
import {geometryBounds,insideGeometry,hasIntersection,demoLocations,buildSubtiles,hospitalityFixture,NEED_TYPES,detailLevel,cameraView,zoomAt} from '../public/map-model.js';
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
