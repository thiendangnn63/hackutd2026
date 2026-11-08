import test from 'node:test';
import assert from 'node:assert/strict';
import { fitCamera, boundCamera, zoomCamera, panCamera, viewBox, fitBounds, MAX_ZOOM } from '../public/houston-camera.js';

test('camera starts and resets at the complete Houston extent', () => {
  assert.deepEqual(fitCamera(), { x: 0, y: 0, zoom: 1 });
  assert.equal(viewBox(fitCamera()), '0 0 800 630');
  assert.deepEqual(zoomCamera({x:200,y:100,zoom:4}, .01), fitCamera());
});
test('zoom preserves an interior pointer anchor and exact aspect ratio', () => {
  const c=zoomCamera(fitCamera(),2,{x:200,y:200});
  assert.deepEqual(c,{x:100,y:100,zoom:2});
  assert.equal((200-c.x)*c.zoom,200);
  assert.equal((200-c.y)*c.zoom,200);
  assert.equal(viewBox(c),'100 100 400 315');
});
test('zoom and pan are bounded, finite, and cannot leave the city canvas', () => {
  const c=zoomCamera(fitCamera(),1000);
  assert.equal(c.zoom,MAX_ZOOM);
  assert.deepEqual(panCamera(c,10000,10000),{x:700,y:551.25,zoom:8});
  assert.deepEqual(panCamera(c,-10000,-10000),{x:0,y:0,zoom:8});
  assert.deepEqual(boundCamera({x:NaN,y:Infinity,zoom:-1}),fitCamera());
  assert.deepEqual(zoomCamera(c,NaN),c);
  assert.deepEqual(zoomCamera(c,0),c);
});
test('repeated zooming and inverse zooming return to full Houston without drift', () => {
  let c=fitCamera();
  for(let i=0;i<15;i++)c=zoomCamera(c,1.5);
  for(let i=0;i<15;i++)c=zoomCamera(c,1/1.5);
  assert.deepEqual(c,fitCamera());
});
test('neighborhood focus zooms to its bounds and retains all of the selected shape', () => {
  const b={x:250,y:200,width:170,height:100};const c=fitBounds(b);
  assert.ok(c.zoom>1);
  assert.ok(c.x<=b.x&&c.y<=b.y);
  assert.ok(c.x+800/c.zoom>=b.x+b.width);
  assert.ok(c.y+630/c.zoom>=b.y+b.height);
});
test('small edge regions and malformed bounds cannot break focus or reset', () => {
  assert.equal(fitBounds({x:795,y:625,width:2,height:2}).zoom,8);
  assert.deepEqual(fitBounds({x:0,y:0,width:0,height:1}),fitCamera());
  assert.deepEqual(fitBounds({x:NaN,y:0,width:10,height:10}),fitCamera());
  assert.deepEqual(fitBounds({x:0,y:0,width:800,height:630}),fitCamera());
});
