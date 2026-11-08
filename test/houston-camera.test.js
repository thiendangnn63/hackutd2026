import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraView,zoomAt} from '../public/map-model.js';
const city={x:400,y:315,zoom:1};
test('camera adapts to the real map viewport without letterboxing',()=>{
  assert.deepEqual(cameraView(city,800,630),{x:0,y:0,width:800,height:630});
  const portrait=cameraView(city,390,700);assert.ok(portrait.height>portrait.width);assert.equal(portrait.x,0);
});
test('zoom preserves the exact world anchor in both axes',()=>{
  const c=zoomAt(city,2,{x:200,y:200});assert.deepEqual(c,{x:300,y:257.5,zoom:2});
  assert.equal((200-c.x)*c.zoom,(200-city.x)*city.zoom);assert.equal((200-c.y)*c.zoom,(200-city.y)*city.zoom);
});
test('zoom is bounded and ignores malformed factors or anchors',()=>{
  assert.equal(zoomAt(city,10000).zoom,24);assert.equal(zoomAt(city,.0001).zoom,.4);
  assert.deepEqual(zoomAt(city,NaN),city);assert.deepEqual(zoomAt(city,0),city);
  assert.deepEqual(zoomAt(city,2,{x:NaN,y:Infinity}),{...city,zoom:2});
  assert.deepEqual(zoomAt({x:NaN,y:Infinity,zoom:NaN},2),{...city,zoom:2});
});
test('inverse wheel zoom returns to the same camera without visible drift',()=>{
  let c=city;for(let i=0;i<5;i++)c=zoomAt(c,1.5,{x:200,y:100});for(let i=0;i<5;i++)c=zoomAt(c,1/1.5,{x:200,y:100});
  assert.ok(Math.abs(c.x-city.x)<1e-10);assert.ok(Math.abs(c.y-city.y)<1e-10);assert.ok(Math.abs(c.zoom-1)<1e-10);
});
