import test from 'node:test';
import assert from 'node:assert/strict';
import {startGesture,moveGesture,zoomAt} from '../public/map-model.js';
const camera={x:400,y:315,zoom:2};
const world=(x,y)=>({x:400+(x-400)*.5,y:315+(y-300)*.5});
test('tap jitter keeps the camera and does not become a drag',()=>{
  const g=startGesture(camera,[{x:400,y:300}],world,.5);
  assert.deepEqual(moveGesture(g,[{x:402,y:302}]),camera);
  assert.equal(g.moved,false);
});
test('drag pans in screen space without requiring a zoomed-in map',()=>{
  const g=startGesture(camera,[{x:400,y:300}],world,.5);
  const next=moveGesture(g,[{x:500,y:360}]);
  assert.equal(g.moved,true);assert.deepEqual(next,{x:350,y:285,zoom:2});
  const city=startGesture({...camera,zoom:1},[{x:400,y:300}],world,1);
  assert.equal(moveGesture(city,[{x:500,y:300}]).x,300);
});
test('two-finger pinch preserves its world anchor and marks the gesture as moved',()=>{
  const g=startGesture(camera,[{x:300,y:300},{x:500,y:300}],world,.5);
  const next=moveGesture(g,[{x:200,y:300},{x:600,y:300}]);
  assert.equal(g.moved,true);assert.equal(next.zoom,4);assert.equal(next.x,400);assert.equal(next.y,315);
});
test('transition from pinch to drag rebases without jumping and cannot be a tap',()=>{
  const initial=startGesture(camera,[{x:300,y:300},{x:500,y:300}],world,.5);
  const after=moveGesture(initial,[{x:300,y:300},{x:700,y:300}]);
  const remaining=startGesture(after,[{x:700,y:300}],world,.25);remaining.moved=true;
  const next=moveGesture(remaining,[{x:740,y:320}]);
  assert.equal(next.zoom,after.zoom);assert.equal(next.x,after.x-10);assert.equal(next.y,after.y-5);assert.equal(remaining.moved,true);
});
test('zoom bounds hold during an extreme pinch without nonfinite coordinates',()=>{
  const g=startGesture(camera,[{x:399,y:300},{x:401,y:300}],world,.5);
  const next=moveGesture(g,[{x:-100000,y:300},{x:100000,y:300}]);
  assert.equal(next.zoom,24);assert.ok(Number.isFinite(next.x)&&Number.isFinite(next.y));
  assert.equal(zoomAt(camera,.000001).zoom,.4);
});
