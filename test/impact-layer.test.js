import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createImpactLayer,updateImpactRetryControl} from '../public/impact-layer.js';
const raw=JSON.parse(readFileSync(new URL('../public/data/houston-water-change.json',import.meta.url),'utf8'));
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.attrs={};this.style={};this.parent=null;}
  setAttribute(key,value){this.attrs[key]=String(value);}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
}
const document={createElementNS(namespace,tag){return new Element(tag);}};
const response=(data=raw)=>({ok:true,json:async()=>structuredClone(data)});
const descendants=node=>node.children.flatMap(child=>[child,...descendants(child)]);
async function withDocument(run){const previous=globalThis.document;globalThis.document=document;try{await run();}finally{if(previous===undefined)delete globalThis.document;else globalThis.document=previous;}}
const project=([x,y])=>[x,-y];
test('local layer remains inert until load, batches bounded SVG paths and keeps comparison/opacity independent',()=>withDocument(async()=>{
  const events=[];let calls=0;const layer=createImpactLayer({project,onStatus:event=>events.push(event),fetchImpl:async url=>{calls++;assert.equal(url,'/data/houston-water-change.json');return response();}});
  assert.equal(calls,0);layer.update(raw.grid.bbox);await layer.load();assert.equal(calls,1);assert.equal(events.at(-1).kind,'ready');
  assert.equal(events.at(-1).comparison.id,raw.comparisons[0].id);assert.ok(descendants(layer.element).filter(node=>node.tagName==='path').length<=25);
  const pattern=layer.element.children[0].children[0];assert.equal(pattern.attrs.width,'18');assert.equal(pattern.attrs.height,'18');
  assert.equal(pattern.children.length,1);assert.equal(pattern.children[0].tagName,'path');assert.equal(pattern.children[0].attrs.fill,'none');
  assert.equal(descendants(pattern).some(node=>node.tagName==='circle'),false);
  layer.setOpacity(.7);assert.equal(layer.element.attrs.opacity,'0.7');layer.setVisible(false);assert.equal(layer.element.style.display,'none');assert.equal(events.at(-1).kind,'hidden');
  assert.equal(layer.setComparison(raw.comparisons[1].id),true);assert.equal(events.at(-1).comparison.afterDate,'2017-09-01');assert.equal(layer.element.attrs.opacity,'0.7');
  assert.equal(layer.setComparison('missing'),false);assert.equal(events.at(-1).comparison.afterDate,'2017-09-01');
  layer.setVisible(true);assert.equal(events.at(-1).kind,'ready');layer.dispose();
}));
test('failed/empty replacement clears old change graphics and retry recovers the chosen available capture',()=>withDocument(async()=>{
  const events=[];let mode='valid';const layer=createImpactLayer({project,onStatus:event=>events.push(event),fetchImpl:async()=>response(mode==='valid'?raw:{...raw,comparisons:[]})});
  await layer.load();assert.ok(layer.element.children[1].children.length);layer.setComparison(raw.comparisons[1].id);
  mode='empty';await layer.load();assert.equal(events.at(-1).available,false);assert.equal(events.at(-1).comparison,null);assert.equal(layer.element.children[1].children.length,0);assert.equal(layer.element.children[2].children.length,0);
  mode='valid';await layer.load();assert.equal(events.at(-1).comparison.id,raw.comparisons[1].id);layer.dispose();
}));
test('late metadata failures and disposed loads cannot overwrite newer state or emit a ready callback',()=>withDocument(async()=>{
  const events=[];let finish,calls=0;const layer=createImpactLayer({project,onStatus:event=>events.push(event),fetchImpl:()=>++calls===1?new Promise(resolve=>{finish=resolve;}):Promise.resolve(response())});
  const old=layer.load();await layer.load();assert.equal(events.at(-1).kind,'ready');finish({ok:false});await old;assert.equal(events.at(-1).kind,'ready');
  let later;const pending=createImpactLayer({project,onStatus:event=>events.push(event),fetchImpl:()=>new Promise(resolve=>{later=resolve;})});
  const loading=pending.load(),count=events.length;pending.dispose();later(response());await loading;assert.equal(events.length,count);layer.dispose();
}));
test('focused Retry recovers to the comparison date or Retry itself without stealing a newer focus',()=>{
  const doc={body:{},activeElement:null},retry={dataset:{},focus(){doc.activeElement=this;}},select={focus(){doc.activeElement=this;}};
  doc.activeElement=retry;updateImpactRetryControl(retry,select,{kind:'loading',available:false},doc);
  assert.equal(retry.hidden,true);assert.equal(retry.dataset.restoreFocus,'true');doc.activeElement=doc.body;
  updateImpactRetryControl(retry,select,{kind:'ready',available:true},doc);assert.equal(doc.activeElement,select);assert.equal(retry.dataset.restoreFocus,undefined);
  doc.activeElement=retry;updateImpactRetryControl(retry,select,{kind:'loading',available:false},doc);doc.activeElement=doc.body;
  updateImpactRetryControl(retry,select,{kind:'unavailable',available:false},doc);assert.equal(doc.activeElement,retry);assert.equal(retry.hidden,false);
  updateImpactRetryControl(retry,select,{kind:'loading',available:false},doc);const other={};doc.activeElement=other;
  updateImpactRetryControl(retry,select,{kind:'ready',available:true},doc);assert.equal(doc.activeElement,other);
});
