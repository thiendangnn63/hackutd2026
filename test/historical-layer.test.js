import test from 'node:test';
import assert from 'node:assert/strict';
import {createHistoricalLayer} from '../public/historical-layer.js';

// Only the SVG operations used by the actual layer are implemented here.
// Images never load from a URL: tests explicitly emit their load/error events.
class SvgNode {
  constructor(tag) {this.tagName=tag;this.children=[];this.parentNode=null;this.style={};this.dataset={};this.attributes={};this.listeners=new Map();}
  setAttribute(name,value) {this.attributes[name]=String(value);}
  getAttribute(name) {return this.attributes[name]??null;}
  append(...nodes) {for(const node of nodes){node.remove();node.parentNode=this;this.children.push(node);}}
  replaceChildren(...nodes) {for(const node of this.children)node.parentNode=null;this.children=[];this.append(...nodes);}
  remove() {if(this.parentNode){this.parentNode.children.splice(this.parentNode.children.indexOf(this),1);this.parentNode=null;}}
  insertBefore(node,before) {node.remove();node.parentNode=this;const index=this.children.indexOf(before);this.children.splice(index<0?this.children.length:index,0,node);}
  addEventListener(type,callback,{once=false}={}) {const listeners=this.listeners.get(type)||[];listeners.push({callback,once});this.listeners.set(type,listeners);}
  emit(type) {for(const listener of [...(this.listeners.get(type)||[])]){listener.callback({type,target:this});if(listener.once)this.listeners.set(type,this.listeners.get(type).filter(item=>item!==listener));}}
}

const bounds=[0,0,1,1];
function metadata(dates=[]) {
  return {water:{available:false,scenes:[]},radar:{available:false},flood:{available:dates.length>0,bbox:bounds,
    imagery:dates.map(date=>({id:'fixture-'+date,date,overview:{id:'overview-'+date,url:'/data/flood-imagery/fixture-'+date+'.webp',bbox:bounds,sourceMetersPerPixel:33},detail:[]}))}};
}
const response=data=>new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
function deferred() {let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve:data=>resolve(response(data)),reject};}
function fixture(t) {
  const originalFetch=globalThis.fetch,originalDocument=globalThis.document,queue=[],statuses=[],ready=[];let calls=0;
  globalThis.document={createElementNS:(_,tag)=>new SvgNode(tag)};
  globalThis.fetch=async url=>{assert.equal(url,'/api/houston/history');calls++;assert.ok(queue.length,'All HTTP calls require a queued local mock');return await queue.shift();};
  const layer=createHistoricalLayer({project:([x,y])=>[x,-y],unproject:([x,y])=>[x,-y],onStatus:status=>statuses.push(status),onReady:value=>ready.push(value)});
  layer.setMode('flood','2017-08-31');layer.update({x:0,y:-1,width:1,height:1},{width:1000,height:700});
  const reference=new SvgNode('g'),referenceImage=new SvgNode('image'),root=new SvgNode('g');reference.append(referenceImage);root.append(reference,layer.element);
  t.after(()=>{layer.dispose();globalThis.fetch=originalFetch;if(originalDocument===undefined)delete globalThis.document;else globalThis.document=originalDocument;});
  return {layer,statuses,ready,reference,referenceImage,root,queue,get calls(){return calls;},
    get images(){return layer.element.children[1].children;},get unknown(){return layer.element.children[0].children;},
    async load(data){queue.push(response(data));await layer.load(true);},
    async retry(data){queue.push(response(data));await layer.retry();},
  };
}

test('missing selected capture resolves to the date actually rendered; available selection stays unchanged',async t=>{
  const h=fixture(t);await h.load(metadata(['2017-08-30','2017-09-01','2017-09-03']));
  assert.equal(h.layer.setMode('flood','2017-08-31'),'2017-08-30');
  assert.equal(h.statuses.at(-1).date,'2017-08-30');assert.match(h.images[0].getAttribute('href'),/2017-08-30/);
  assert.equal(h.layer.setMode('flood','2017-09-01'),'2017-09-01');
  assert.equal(h.statuses.at(-1).date,'2017-09-01');assert.match(h.images[0].getAttribute('href'),/2017-09-01/);
});

test('populated to empty clears event images/backdrop and old callbacks without touching reference context',async t=>{
  const h=fixture(t);await h.load(metadata(['2017-08-31']));const oldImage=h.images[0];
  assert.equal(h.images.length,1);assert.equal(h.unknown.length,1);
  await h.load(metadata());
  assert.equal(h.images.length,0);assert.equal(h.unknown.length,0);assert.equal(oldImage.parentNode,null);assert.equal(h.layer.element.style.display,'none');
  assert.equal(h.reference.parentNode,h.root);assert.deepEqual(h.reference.children,[h.referenceImage]);
  assert.deepEqual(h.statuses.at(-1),{mode:'flood',kind:'unavailable',reason:'no-capture',label:'No dated capture · reference context',date:null,scene:null,outsideCapture:false});
  const count=h.statuses.length;oldImage.emit('load');oldImage.emit('error');assert.equal(h.statuses.length,count);assert.equal(h.images.length,0);
});

test('one Retry refreshes an empty inventory and recovers the remembered capture',async t=>{
  const h=fixture(t);await h.load(metadata());assert.equal(h.calls,1);assert.equal(h.layer.setMode('flood','2017-08-31'),undefined);
  await h.retry(metadata(['2017-08-30','2017-08-31']));assert.equal(h.calls,2);assert.equal(h.images.length,1);assert.equal(h.layer.element.style.display,'');
  h.images[0].emit('load');assert.equal(h.statuses.at(-1).kind,'ready');assert.equal(h.statuses.at(-1).date,'2017-08-31');assert.match(h.images[0].getAttribute('href'),/2017-08-31/);
});

test('a failed URL can recover after empty metadata through one Retry',async t=>{
  const h=fixture(t);await h.load(metadata(['2017-08-31']));h.images[0].emit('error');assert.equal(h.statuses.at(-1).kind,'unavailable');
  await h.load(metadata());assert.equal(h.images.length,0);
  await h.retry(metadata(['2017-08-31']));assert.equal(h.calls,3);assert.equal(h.images.length,1);
  h.images[0].emit('load');assert.equal(h.statuses.at(-1).kind,'ready');assert.equal(h.statuses.at(-1).date,'2017-08-31');
});

test('an older metadata success cannot replace a newer empty inventory or publish stale status',async t=>{
  const h=fixture(t);await h.load(metadata(['2017-08-31']));const older=deferred(),latest=deferred();
  h.queue.push(older.promise);const oldLoad=h.layer.load(true);h.queue.push(latest.promise);const newLoad=h.layer.load(true);
  latest.resolve(metadata());await newLoad;const count=h.statuses.length,readyCount=h.ready.length;
  older.resolve(metadata(['2017-09-03']));await oldLoad;
  assert.equal(h.statuses.length,count);assert.equal(h.ready.length,readyCount);assert.deepEqual(h.layer.dates('flood'),[]);assert.equal(h.images.length,0);assert.equal(h.layer.element.style.display,'none');assert.equal(h.statuses.at(-1).reason,'no-capture');
});

test('an older metadata error cannot overwrite a newer success or invalidate its shared cache',async t=>{
  const h=fixture(t);await h.load(metadata(['2017-08-31']));const older=deferred(),latest=deferred();
  h.queue.push(older.promise);const oldLoad=h.layer.load(true);h.queue.push(latest.promise);const newLoad=h.layer.load(true);
  latest.resolve(metadata(['2017-08-30']));await newLoad;h.images[0].emit('load');const count=h.statuses.length,readyCount=h.ready.length;
  older.reject(new Error('A synthetic stale metadata failure'));await oldLoad;
  assert.equal(h.statuses.length,count);assert.equal(h.ready.length,readyCount);assert.equal(h.statuses.at(-1).date,'2017-08-30');assert.equal(h.statuses.at(-1).kind,'ready');
  await h.layer.load();assert.equal(h.calls,3,'The accepted metadata promise remains cached');assert.deepEqual(h.layer.dates('flood').map(item=>item.value),['2017-08-30']);assert.equal(h.statuses.at(-1).date,'2017-08-30');
});
