import test from 'node:test';
import assert from 'node:assert/strict';

// Small event/DOM harness, not a browser substitute. Browser QA covers actual layout,
// hit testing and focus. This checks interrupted and multi-pointer gesture behavior.
class Element {
  constructor(tag) { this.tagName=tag;this.children=[];this.attrs={};this.listeners={};this.dataset={};this.hidden=false;this.capture=new Set();
    this.classList={add:()=>{},remove:()=>{},toggle:()=>{}}; }
  append(...nodes) { for(const n of nodes){n.parentElement=this;this.children.push(n);} }
  replaceChildren(...nodes) { this.children=[];this.append(...nodes); }
  get lastChild(){return this.children.at(-1);}
  setAttribute(k,v){this.attrs[k]=String(v);}
  getAttribute(k){return this.attrs[k]??null;}
  addEventListener(type,listener){(this.listeners[type]??=[]).push(listener);}
  fire(type,event={}) { const e={target:this,preventDefault(){},stopPropagation(){},...event};for(const fn of this.listeners[type]||[])fn(e); }
  closest(selector){return selector==='.houston-region'&&this.attrs.class==='houston-region'?this:null;}
  contains(other){return this===other||this.children.some(c=>c.contains(other));}
  focus(){document.activeElement=this;this.fire('focus');}
  scrollIntoView(){}
  setPointerCapture(id){this.capture.add(id);}
  hasPointerCapture(id){return this.capture.has(id);}
  releasePointerCapture(id){this.capture.delete(id);}
  getBBox(){return {x:200,y:150,width:70,height:55};}
  getScreenCTM(){const [x,y,w]=this.attrs.viewBox.split(' ').map(Number);return {a:800/w,inverse:()=>({x,y,unit:w/800})};}
  createSVGPoint(){return {x:0,y:0,matrixTransform(m){return{x:m.x+this.x*m.unit,y:m.y+this.y*m.unit};}};}
}
const all=(root,predicate)=>[...(predicate(root)?[root]:[]),...root.children.flatMap(c=>all(c,predicate))];
const find=(root,predicate)=>all(root,predicate)[0];
const region=(id,count,categories)=>({id,name:id,openCount:count,categories,priority:count?'supplies':'coverage_check',geometry:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}});

test('map events preserve color-only overview, touch selection and gesture resets',async t=>{
  const oldDocument=globalThis.document,oldFetch=globalThis.fetch;
  const root=new Element('div'),status=new Element('p'),scenario=new Element('select');scenario.value='normal';
  globalThis.document={querySelector:s=>({'#houston-content':root,'#houston-status':status,'#houston-scenario':scenario}[s]),createElement:t=>new Element(t),createElementNS:(_,t)=>new Element(t),activeElement:null};
  globalThis.fetch=async()=>({ok:true,json:async()=>({available:true,city:{id:'houston',bbox:[0,0,1,1],boundary:{type:'Polygon',coordinates:[[[0,0],[1,0],[1,1],[0,1],[0,0]]]}},regions:[region('A',300,{supplies:300}),region('B',100,{evacuation:100}),region('C',0,{})],stats:{openRequests:400},urgentRequests:[],unlocatedRequests:[]})});
  try {
    await import(`../public/houston.js?gesture-test=${Date.now()}`);
    await new Promise(resolve=>setImmediate(resolve));
    const svg=find(root,e=>e.tagName==='svg'),paths=all(svg,e=>e.attrs.role==='button');
    const detail=find(root,e=>e.className==='houston-detail'),tip=find(root,e=>e.className==='houston-map-tooltip');
    const fit=find(root,e=>e.tagName==='button'&&e.textContent==='Fit Houston');
    await t.test('no persistent numeric labels or default statistics; hover and focus reveal counts',()=>{
      assert.equal(all(svg,e=>e.tagName==='text').length,0);assert.equal(detail.hidden,true);assert.equal(tip.hidden,true);
      paths[0].fire('pointerenter');assert.equal(tip.hidden,false);assert.match(tip.children[0].textContent,/300/);assert.equal(detail.hidden,true);
      paths[0].fire('pointerleave');assert.equal(tip.hidden,true);
      paths[1].focus();assert.match(tip.children[0].textContent,/100/);
    });
    await t.test('single touch selects a neighborhood and shows statistics on the map',()=>{
      svg.fire('pointerdown',{button:0,pointerId:1,clientX:200,clientY:200,target:paths[1]});
      svg.fire('pointerup',{pointerId:1});
      assert.equal(detail.hidden,false);assert.equal(detail.parentElement.className,'houston-map-frame');assert.notEqual(svg.attrs.viewBox,'0 0 800 630');assert.equal(document.activeElement,detail);
      detail.fire('keydown',{key:'Escape'});assert.equal(detail.hidden,true);assert.equal(svg.attrs.viewBox,'0 0 800 630');
    });
    await t.test('dragging never opens a neighborhood popover',()=>{
      find(root,e=>e.attrs['aria-label']==='Zoom in').fire('click');const before=svg.attrs.viewBox;
      svg.fire('pointerdown',{button:0,pointerId:2,clientX:400,clientY:300,target:paths[0]});
      svg.fire('pointermove',{pointerId:2,clientX:450,clientY:350});
      svg.fire('pointerup',{pointerId:2});assert.notEqual(svg.attrs.viewBox,before);assert.equal(detail.hidden,true);
    });
    await t.test('two-finger pinch zooms without accidental selection and cancellation releases state',()=>{
      fit.fire('click');
      svg.fire('pointerdown',{button:0,pointerId:3,clientX:300,clientY:300,target:paths[0]});
      svg.fire('pointerdown',{button:0,pointerId:4,clientX:500,clientY:300,target:paths[1]});
      svg.fire('pointermove',{pointerId:4,clientX:650,clientY:300});
      assert.ok(Number(svg.attrs.viewBox.split(' ')[2])<800);assert.equal(detail.hidden,true);
      svg.fire('pointercancel',{pointerId:3});svg.fire('pointercancel',{pointerId:4});assert.equal(svg.capture.size,0);
      fit.fire('click');assert.equal(svg.attrs.viewBox,'0 0 800 630');
      svg.fire('pointerdown',{button:0,pointerId:5,clientX:200,clientY:200,target:paths[2]});svg.fire('pointerup',{pointerId:5});assert.equal(detail.hidden,false);
    });
    await t.test('keyboard open, reset and repeated clicks preserve the city clip and coverage lane',()=>{
      fit.fire('click');paths[0].fire('keydown',{key:'Enter'});assert.equal(detail.hidden,false);
      fit.fire('click');fit.fire('click');assert.equal(svg.attrs.viewBox,'0 0 800 630');assert.equal(detail.hidden,true);
      assert.ok(find(svg,e=>e.attrs['clip-rule']==='evenodd'));
      assert.equal(all(root,e=>e.className==='houston-coverage-row').length,1);
      assert.equal(all(svg,e=>e.tagName==='text').length,0);
    });
  } finally {globalThis.document=oldDocument;globalThis.fetch=oldFetch;}
});
