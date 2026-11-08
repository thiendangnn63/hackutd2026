import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareStreetLabels,clippedStreetPaths,chooseStreetLabels,searchGeographicReferences,createGeographicSearchIndex,searchGeographicIndex,geographicReferenceBounds,labelBoxesOverlap} from '../public/labels-model.js';

const view={x:0,y:0,width:500,height:300};
const road=(name,coordinates,rank=1,id=name)=>prepareStreetLabels({features:[{properties:{id,name,rank},geometry:{type:'LineString',coordinates}}]},p=>[...p])[0];
test('road clipping retains visible crossings and never bridges disconnected viewport runs',()=>{
  assert.deepEqual(clippedStreetPaths([[-20,100],[600,100]],view),[[[0,100],[500,100]]]);
  const runs=clippedStreetPaths([[10,10],[600,10],[600,250],[10,250]],view);
  assert.equal(runs.length,2);assert.deepEqual(runs[0].at(-1),[500,10]);assert.deepEqual(runs[1][0],[500,250]);
});
test('street labels follow visible road direction, remain upright, and avoid bends and offscreen labels',()=>{
  const straight=road('Main Street',[[490,150],[10,150]]);
  const labels=chooseStreetLabels([straight],view);assert.equal(labels.length,1);assert.equal(labels[0].angle,0);assert.equal(labels[0].y,150);
  const bend=road('Sharp Corner',[[80,250],[250,250],[250,80]]);
  assert.equal(chooseStreetLabels([bend],view).length,0);
  assert.equal(chooseStreetLabels([road('Tiny Street',[[2,2],[15,2]])],view).length,0);
});
test('label hierarchy honors zoom ranks, avoids occupied markers and removes duplicate road-name clutter without mutation',()=>{
  const streets=[road('Main Street',[[20,80],[480,80]],1,'first'),road('Main Street',[[20,220],[480,220]],1,'second'),road('Side Road',[[20,150],[480,150]],2)];
  const original=structuredClone(streets),occupied=[{x:210,y:60,width:80,height:40}];
  const labels=chooseStreetLabels(streets,view,{rankLimit:1,occupied});assert.equal(labels.length,1);assert.equal(labels[0].y,220);
  assert.ok(labels.every(label=>!occupied.some(box=>labelBoxesOverlap(box,label.bounds))));assert.deepEqual(streets,original);
  assert.equal(chooseStreetLabels(streets,view,{rankLimit:2}).length,2);
});
test('real geographic reference search is literal, name-ranked and independent of assistance fixtures',()=>{
  const streets=[road('Main Street',[[0,0],[100,100]]),road('South Main Street',[[0,0],[100,100]])];
  const points=[{id:'park',name:'Main Street Park',rank:1,point:[50,50],kind:'park',contextOnly:true}];
  const hits=searchGeographicReferences(streets,points,'Main Street');assert.equal(hits[0].name,'Main Street');assert.equal(hits.length,3);
  assert.equal(searchGeographicReferences(streets,points,'<svg>').length,0);assert.deepEqual(searchGeographicReferences(streets,points,'  '),[]);
  assert.ok(hits.every(hit=>hit.openCount===undefined&&hit.hospitality===undefined));
});

test('street search understands full street types and directions while preserving exact source names',()=>{
  const streets=[road('N MAIN ST',[[0,0],[100,100]]),road('BUFFALO SPWY',[[0,0],[100,100]]),road('SHEPHERD DR',[[0,0],[100,100]])];
  assert.equal(searchGeographicReferences(streets,[],'North Main Street')[0].name,'N MAIN ST');
  assert.equal(searchGeographicReferences(streets,[],'Shepherd Drive')[0].name,'SHEPHERD DR');
  assert.equal(searchGeographicReferences(streets,[],'Main St.')[0].name,'N MAIN ST');
  assert.equal(searchGeographicReferences(streets,[],'<street> Main').length,0);
});

test('same-name street search retains all source segments and uses their strongest rank and full extent',()=>{
  const first=road('MAIN ST',[[-95.5,29.75],[-95.4,29.75]],2,'west');
  const second=road('MAIN ST',[[-95.33,29.73],[-95.3,29.72]],0,'east');
  const index=createGeographicSearchIndex([first,second],[]);
  const [hit]=searchGeographicIndex(index,'Main Street');
  assert.equal(index.length,1);assert.equal(hit.rank,0);
  assert.deepEqual(hit.geometry.coordinates,[first.geometry.coordinates,second.geometry.coordinates]);
  assert.deepEqual(geographicReferenceBounds(hit),[-95.5,29.72,-95.3,29.75]);
  assert.equal(searchGeographicIndex(index,'constructor').length,0);
});
test('horizontal and vertical street selections receive nonzero bounds centered on their real geometry',()=>{
  const horizontal=road('HORIZONTAL',[[-95.5,29.75],[-95.4,29.75]]);
  const vertical=road('VERTICAL',[[-95.5,29.7],[-95.5,29.8]]);
  const index=createGeographicSearchIndex([horizontal,vertical],[]);
  const h=geographicReferenceBounds(searchGeographicIndex(index,'horizontal')[0]);
  const v=geographicReferenceBounds(searchGeographicIndex(index,'vertical')[0]);
  assert.deepEqual([h[0],h[2]],[-95.5,-95.4]);assert.ok(h[1]<29.75&&h[3]>29.75);
  assert.deepEqual([v[1],v[3]],[29.7,29.8]);assert.ok(v[0]<-95.5&&v[2]>-95.5);
});
