import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareObservationCoverage,observationCoverage,suggestObservationDate} from '../public/map-coverage.js';

const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1e-10,`${actual} != ${expected}`);
function scene(date,counts,{width=4,height=2,block=2,bbox=[0,0,width,height]}={}){
  return {date,bbox,width,height,columns:Math.ceil(width/block),rows:Math.ceil(height/block),counts,knownPixels:counts.reduce((a,b)=>a+b,0)};
}
const metadata=(scenes,blockSize=2)=>({schemaVersion:1,crs:'EPSG:4326',encoding:'observed-pixel-counts',blockSize,scenes});

test('exact block counts distinguish observed, no observation, and missing metadata',()=>{
  const prepared=prepareObservationCoverage(metadata([scene('2017-08-30',[0,4])]));
  const missing=observationCoverage(null,[0,0,2,2],'2017-08-30');assert.equal(missing.available,false);assert.equal(missing.knownFraction,null);assert.equal(missing.status,'unavailable');
  const empty=observationCoverage(prepared,[0,0,2,2],'2017-08-30');assert.equal(empty.available,true);assert.equal(empty.status,'unobserved');assert.equal(empty.knownFraction,0);assert.equal(empty.upperFraction,0);assert.equal(empty.exactKnownPixels,0);
  const observed=observationCoverage(prepared,[2,0,4,2],'2017-08-30');assert.equal(observed.status,'observed');assert.equal(observed.knownFraction,1);assert.equal(observed.exactKnownPixels,4);assert.equal(observed.approximate,false);
  assert.equal(observationCoverage(prepared,[0,0,4,2],'2017-09-01').available,false);
});

test('outside observation extent is separately counted, including partially outside views',()=>{
  const prepared=prepareObservationCoverage(metadata([scene('2017-08-30',[4],{width:2,height:2})]));
  const outside=observationCoverage(prepared,[-2,0,-1,2],'2017-08-30');assert.equal(outside.status,'outside');assert.equal(outside.outsideFraction,1);assert.equal(outside.insidePixels,0);assert.equal(outside.knownFraction,0);
  const partial=observationCoverage(prepared,[-1,0,1,2],'2017-08-30');close(partial.outsideFraction,.5);close(partial.knownFraction,.5);assert.equal(partial.totalPixels,4);assert.equal(partial.insidePixels,2);assert.equal(partial.exactKnownPixels,2);assert.equal(partial.status,'partial');
});

test('smaller edge cells are weighted by native pixel area rather than averaging percentages',()=>{
  const prepared=prepareObservationCoverage(metadata([scene('2017-08-30',[0,1],{width:3,height:1})]));
  const full=observationCoverage(prepared,[0,0,3,1],'2017-08-30');close(full.knownFraction,1/3);assert.equal(full.exactKnownPixels,1);
  const edge=observationCoverage(prepared,[2.25,0,3,1],'2017-08-30');assert.equal(edge.knownFraction,1);assert.equal(edge.approximate,false);assert.equal(edge.exactKnownPixels,null);close(edge.knownPixelsEstimate,.75);
});

test('partial mixed blocks expose a weighted estimate and rigorous uncertainty, never exact false precision',()=>{
  const prepared=prepareObservationCoverage(metadata([scene('2017-08-30',[2],{width:2,height:2})]));
  const half=observationCoverage(prepared,[0,0,1,2],'2017-08-30');assert.equal(half.knownFraction,.5);assert.equal(half.lowerFraction,0);assert.equal(half.upperFraction,1);assert.equal(half.approximate,true);assert.equal(half.exactKnownPixels,null);
  const whole=observationCoverage(prepared,[0,0,2,2],'2017-08-30');assert.equal(whole.knownFraction,.5);assert.equal(whole.lowerFraction,.5);assert.equal(whole.upperFraction,.5);assert.equal(whole.approximate,false);assert.equal(whole.exactKnownPixels,2);
});

test('fully observed fractional queries retain their status despite summation roundoff',()=>{
  const width=13,height=11,counts=[];for(let y=0;y<height;y+=2)for(let x=0;x<width;x+=2)counts.push(Math.min(2,width-x)*Math.min(2,height-y));
  const prepared=prepareObservationCoverage(metadata([scene('2017-08-30',counts,{width,height})]));
  const result=observationCoverage(prepared,[2.4952543363906443,4.404620501445606,9.120508612133563,6.7779514824505895],'2017-08-30');
  assert.equal(result.status,'observed');assert.equal(result.approximate,false);close(result.lowerFraction,1);assert.equal(result.outsideFraction,0);
});

test('full-prefix and partial-boundary queries bound actual source-pixel coverage across weighted cells',()=>{
  const width=5,height=5,block=2,known=Array.from({length:height},(_,y)=>Array.from({length:width},(_,x)=>(x+y)%3===0));
  const counts=[];for(let row=0;row<height;row+=block)for(let col=0;col<width;col+=block){let n=0;for(let y=row;y<Math.min(height,row+block);y++)for(let x=col;x<Math.min(width,col+block);x++)n+=known[y][x];counts.push(n);}
  const prepared=prepareObservationCoverage(metadata([scene('2017-08-30',counts,{width,height,block})],block));
  for(const bounds of [[0,0,5,5],[.25,.5,4.5,4.75],[-1,-1,3.5,6],[1,1,4,4],[4.25,0,5,4.5]]){
    let exact=0;const area=(bounds[2]-bounds[0])*(bounds[3]-bounds[1]);
    for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(known[y][x])exact+=Math.max(0,Math.min(bounds[2],x+1)-Math.max(bounds[0],x))*Math.max(0,Math.min(bounds[3],height-y)-Math.max(bounds[1],height-y-1));
    const result=observationCoverage(prepared,bounds,'2017-08-30'),actual=exact/area;
    assert.ok(result.lowerFraction<=actual+1e-10);assert.ok(result.upperFraction>=actual-1e-10);assert.ok(result.knownFraction>=result.lowerFraction-1e-10);assert.ok(result.knownFraction<=result.upperFraction+1e-10);
  }
});

test('invalid dimensions, counts, dates, duplicates, bounds and schemas stay unavailable',()=>{
  const good=metadata([scene('2017-08-30',[0,4])]);
  for(const value of [null,{}, {...good,crs:'EPSG:3857'}, {...good,blockSize:0}, {...good,scenes:[]}])assert.equal(prepareObservationCoverage(value),null);
  for(const change of [{width:0},{width:10001},{date:'2017-02-30'},{bbox:[0,0,0,1]},{columns:9},{knownPixels:3},{counts:[0,5]},{counts:[0,-1]},{counts:[0,1.5]},{counts:[0]},{counts:[0,NaN]}])assert.equal(prepareObservationCoverage(metadata([{...good.scenes[0],...change}])),null);
  assert.equal(prepareObservationCoverage(metadata([good.scenes[0],good.scenes[0]])),null);
  const prepared=prepareObservationCoverage(good);for(const bounds of [null,[0,0,0,1],[1,0,0,1],[0,0,NaN,1],[-181,0,1,1]])assert.equal(observationCoverage(prepared,bounds,'2017-08-30').available,false);
});

test('alternative suggestions use only clearly better post-event dates permitted by the current mode',()=>{
  const prepared=prepareObservationCoverage(metadata([scene('2017-08-15',[4,4]),scene('2017-08-30',[3,3]),scene('2017-09-01',[0,0])]));
  const bounds=[0,0,4,2],suggested=suggestObservationDate(prepared,bounds,'2017-09-01');assert.equal(suggested.date,'2017-08-30');assert.equal(suggested.coverage.knownFraction,.75);assert.equal(suggested.currentCoverage.knownFraction,0);
  assert.equal(suggestObservationDate(prepared,bounds,'2017-08-30'),null);
  assert.equal(suggestObservationDate(prepared,bounds,'2017-09-01',{allowedDates:['2017-08-15','2017-09-01']}),null);
  assert.equal(suggestObservationDate(prepared,bounds,'2017-09-01',{allowedDates:[]}),null);
  assert.equal(suggestObservationDate(prepared,bounds,'2017-09-01',{notBefore:'2017-09-01'}),null);
  assert.equal(suggestObservationDate(prepared,bounds,'2017-09-01',{minCoverage:.8}),null);
  assert.equal(suggestObservationDate(prepared,bounds,'2017-09-01',{minGain:.8}),null);
  assert.equal(suggestObservationDate(prepared,[-2,0,-1,2],'2017-09-01'),null);
});

test('uncertain partial-block gains are not promoted as reliable alternative observations',()=>{
  const prepared=prepareObservationCoverage(metadata([scene('2017-08-30',[3],{width:2,height:2}),scene('2017-09-01',[0],{width:2,height:2})]));
  const result=observationCoverage(prepared,[0,0,.5,1],'2017-08-30');assert.equal(result.knownFraction,.75);assert.equal(result.lowerFraction,0);
  assert.equal(suggestObservationDate(prepared,[0,0,.5,1],'2017-09-01'),null);
});

test('compilation and queries are deterministic, leave caller data untouched, and copy mutable counts',()=>{
  const raw=metadata([scene('2017-08-30',[4,4]),scene('2017-09-01',[0,0])]),before=structuredClone(raw),bounds=[0,0,4,2],originalBounds=[...bounds];
  const a=prepareObservationCoverage(raw),b=prepareObservationCoverage(raw);
  assert.deepEqual(observationCoverage(a,bounds,'2017-08-30'),observationCoverage(b,bounds,'2017-08-30'));
  assert.deepEqual(suggestObservationDate(a,bounds,'2017-09-01'),suggestObservationDate(b,bounds,'2017-09-01'));
  assert.deepEqual(raw,before);assert.deepEqual(bounds,originalBounds);assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen(a.dates));
  raw.scenes[0].counts.fill(0);raw.scenes[0].bbox[0]=-100;
  assert.equal(observationCoverage(a,bounds,'2017-08-30').knownFraction,1);
});

test('bundled historical masks expose the actual Barker and Kingwood date gaps and suggest only post-event alternatives',()=>{
  const raw=JSON.parse(readFileSync(new URL('../public/data/houston-observation-coverage.json',import.meta.url),'utf8')),prepared=prepareObservationCoverage(raw);
  assert.ok(prepared);assert.deepEqual(prepared.dates,['2017-08-15','2017-08-30','2017-09-01']);
  const barker=[-95.72,29.74472,-95.69548,29.76780],kingwood=[-95.22,30,-95.195,30.023],allowedDates=['2017-08-15','2017-08-30','2017-09-01'];
  assert.equal(observationCoverage(prepared,barker,'2017-09-01').upperFraction,0);
  assert.equal(observationCoverage(prepared,kingwood,'2017-08-30').upperFraction,0);
  assert.equal(suggestObservationDate(prepared,barker,'2017-09-01',{allowedDates}).date,'2017-08-30');
  assert.equal(suggestObservationDate(prepared,kingwood,'2017-08-30',{allowedDates}).date,'2017-09-01');
  assert.equal(suggestObservationDate(prepared,barker,'2017-09-01',{allowedDates:['2017-08-15','2017-09-01']}),null);
});
