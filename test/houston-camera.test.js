import test from 'node:test';
import assert from 'node:assert/strict';
import {cameraView,zoomAt,fitMapCamera,startGesture,moveGesture} from '../public/map-model.js';
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


const screenPoint=(camera,width,height,point)=>({
  x:width/2+(point.x-camera.x)*width*camera.zoom/800,
  y:height/2+(point.y-camera.y)*width*camera.zoom/800
});
function assertFits(bounds,width,height,insets={}){
  const camera=fitMapCamera(bounds,width,height,insets),padding=insets.padding??24;
  const first=screenPoint(camera,width,height,{x:bounds.x,y:bounds.y});
  const last=screenPoint(camera,width,height,{x:bounds.x+bounds.width,y:bounds.y+bounds.height});
  assert.ok(first.x>=(insets.left??0)+padding-1e-8);
  assert.ok(first.y>=(insets.top??0)+padding-1e-8);
  assert.ok(last.x<=width-(insets.right??0)-padding+1e-8);
  assert.ok(last.y<=height-(insets.bottom??0)-padding+1e-8);
  return camera;
}

test('fit camera contains the complete projected Houston bounds in wide, short and portrait viewports',()=>{
  const bounds={x:35,y:30,width:730,height:570};
  for(const [width,height,insets]of [
    [2560,720,{left:340,right:64,top:80,bottom:45}],
    [1920,540,{left:340,right:64,top:80,bottom:45}],
    [1440,960,{left:340,right:80,top:65,bottom:40}],
    [390,844,{top:70,bottom:320,padding:16}],
    [1365.5,723.25,{left:311.25,right:55.5,top:60.25,bottom:34.5}]
  ]){
    const camera=assertFits(bounds,width,height,insets);
    if(width>=1920)assert.ok(camera.zoom<.4,`wide viewport must be able to fit below the old floor: ${width}`);
    const center=screenPoint(camera,width,height,{x:400,y:315});
    assert.ok(Math.abs(center.x-((insets.left??0)+width-(insets.right??0))/2)<1e-8);
    assert.ok(Math.abs(center.y-((insets.top??0)+height-(insets.bottom??0))/2)<1e-8);
  }
});

test('fit camera respects zero padding, max zoom, and malformed-input fallback',()=>{
  const bounds={x:0,y:0,width:800,height:630};
  assert.deepEqual(fitMapCamera(bounds,800,630,{padding:0}),city);
  assert.equal(fitMapCamera({x:10,y:20,width:1,height:1},800,630).zoom,24);
  for(const [box,width,height,insets]of [
    [null,800,630,{}],[{...bounds,width:0},800,630,{}],
    [{...bounds,x:NaN},800,630,{}],[bounds,0,630,{}],[bounds,800,Infinity,{}],
    [bounds,800,630,{left:800}],[bounds,800,630,{bottom:-1}],
    [bounds,800,630,{padding:NaN}],[bounds,800,630,null]
  ])assert.deepEqual(fitMapCamera(box,width,height,insets),city);
});

test('a fitted camera can zoom below .4 and back without shifting its world anchor',()=>{
  const fitted=fitMapCamera({x:35,y:30,width:730,height:570},2560,720,{left:340,top:80,bottom:45});
  const anchor={x:300,y:200},minimum=.01;
  const zoomedOut=zoomAt(fitted,.5,anchor,minimum),zoomedBack=zoomAt(zoomedOut,2,anchor,minimum);
  assert.ok(zoomedOut.zoom<.4);assert.ok(zoomedOut.zoom<fitted.zoom);
  for(const c of [zoomedOut,zoomedBack]){
    assert.ok(Math.abs((anchor.x-c.x)*c.zoom-(anchor.x-fitted.x)*fitted.zoom)<1e-10);
    assert.ok(Math.abs((anchor.y-c.y)*c.zoom-(anchor.y-fitted.y)*fitted.zoom)<1e-10);
  }
  assert.ok(Math.abs(zoomedBack.x-fitted.x)<1e-10);assert.ok(Math.abs(zoomedBack.y-fitted.y)<1e-10);
  assert.equal(zoomAt(fitted,.0001,anchor,.01).zoom,.01);
});

test('pinching and dragging a fitted camera honors the supplied floor without a .4 snap',()=>{
  const fitted=fitMapCamera({x:35,y:30,width:730,height:570},2560,720,{left:340,top:80,bottom:45});
  const width=2560,height=720,unit=800/width/fitted.zoom;
  const world=(x,y)=>({x:fitted.x+(x-width/2)*unit,y:fitted.y+(y-height/2)*unit});
  const gesture=startGesture(fitted,[{x:1100,y:360},{x:1300,y:360}],world,unit,.01);
  const unchanged=moveGesture(gesture,[{x:1100,y:360},{x:1300,y:360}]);
  assert.deepEqual(unchanged,fitted);
  const pinched=moveGesture(gesture,[{x:1150,y:360},{x:1250,y:360}]);
  assert.equal(pinched.zoom,fitted.zoom/2);assert.ok(pinched.zoom<.4);
  const anchor=world(1200,360);
  assert.ok(Math.abs((anchor.x-pinched.x)*pinched.zoom-(anchor.x-fitted.x)*fitted.zoom)<1e-10);
  const drag=startGesture(pinched,[{x:1200,y:360}],world,unit*fitted.zoom/pinched.zoom,.01);
  const moved=moveGesture(drag,[{x:1240,y:380}]);
  assert.equal(moved.zoom,pinched.zoom);
  assert.ok(Math.abs(moved.x-(pinched.x-40*unit*fitted.zoom/pinched.zoom))<1e-10);
});
