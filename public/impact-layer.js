import {svgNode} from './ui.js';
import {prepareImpact,impactCells,impactCoverage,strongestImpactExample} from './impact-model.js';
let serial=0;
export function updateImpactRetryControl(retry,select,state,doc=globalThis.document){
  if(state.kind==='loading'&&doc.activeElement===retry)retry.dataset.restoreFocus='true';
  retry.disabled=state.kind==='loading';retry.hidden=state.kind!=='unavailable';
  if(retry.dataset.restoreFocus==='true'&&(state.available&&state.kind!=='loading'||state.kind==='unavailable')){
    delete retry.dataset.restoreFocus;
    if(doc.activeElement===retry||doc.activeElement===doc.body)(state.available?select:retry).focus({preventScroll:true});
  }
}
export function createImpactLayer({project,onStatus=()=>{},fetchImpl=globalThis.fetch,comparisonId=null}={}){
  const patternId='impact-unknown-'+(++serial),element=svgNode('g',{class:'map-impact-layer','aria-hidden':'true','pointer-events':'none'}),defs=svgNode('defs');
  const pattern=svgNode('pattern',{id:patternId,width:18,height:18,patternUnits:'userSpaceOnUse'});
  pattern.append(svgNode('path',{d:'M-1 1L1-1M0 18L18 0M17 19L19 17',fill:'none',stroke:'#b2a38a','stroke-width':.55,opacity:.7}));defs.append(pattern);element.append(defs);
  const heat=svgNode('g'),unknown=svgNode('g');element.append(heat,unknown);
  let prepared=null,selected=null,currentExample=null,desiredId=comparisonId,visible=true,disposed=false,loading=false,requestId=0,bounds=null,abort;
  const example=()=>currentExample?{...currentExample,bounds:[...currentExample.bounds]}:null;
  const rectangle=bbox=>{const a=project([bbox[0],bbox[3]]),b=project([bbox[2],bbox[1]]);return {x:a[0],y:a[1],width:b[0]-a[0],height:b[1]-a[1]};};
  function report(kind=prepared?'ready':loading?'loading':'unavailable'){
    if(disposed)return;
    onStatus({kind:visible?kind:'hidden',available:Boolean(prepared),comparisons:prepared?.comparisons||[],comparison:selected,
      coverage:prepared&&selected&&bounds?impactCoverage(prepared,selected.id,bounds):null,
      example:example(),
      cellSizeMeters:prepared?prepared.grid.cellSize*prepared.grid.nativeResolutionMeters:null});
  }
  function draw(){
    heat.replaceChildren();unknown.replaceChildren();
    currentExample=prepared&&selected?strongestImpactExample(prepared,selected.id):null;
    if(!prepared||!selected)return;
    const colors=new Map(),missing=new Map();
    for(const cell of impactCells(prepared,selected.id)){
      const box=rectangle(cell.bounds),path=`M${box.x},${box.y}h${box.width}v${box.height}h${-box.width}Z`;
      // Fixed 0–100+ scale with a perceptual curve; partial cells are faded by
      // joint valid coverage rather than asserting the entire cell was seen.
      const strength=cell.displayScore===null?0:Math.round(Math.sqrt(cell.displayScore/100)*cell.coverage*20)/20;
      if(strength>0)colors.set(strength,(colors.get(strength)||'')+path);
      const absent=Math.round((1-cell.coverage)*4)/4;
      if(absent>0)missing.set(absent,(missing.get(absent)||'')+path);
    }
    for(const [opacity,d]of colors)heat.append(svgNode('path',{d,fill:'#ffbd59','fill-opacity':opacity}));
    for(const [opacity,d]of missing)unknown.append(svgNode('path',{d,fill:`url(#${patternId})`,'fill-opacity':opacity*.3}));
  }
  const controller={element,
    async load(){
      if(disposed)return;const id=++requestId;abort?.abort();abort=new AbortController();loading=true;report('loading');
      try{
        const response=await fetchImpl('/data/houston-water-change.json',{signal:abort.signal});if(!response.ok)throw new Error();
        const next=prepareImpact(await response.json());if(!next)throw new Error();
        if(disposed||id!==requestId)return;
        const previous=desiredId||selected?.id;prepared=next;selected=next.comparisons.find(item=>item.id===previous)||next.comparisons[0];desiredId=selected.id;loading=false;draw();report();
      }catch{
        if(disposed||id!==requestId)return;prepared=null;selected=null;loading=false;draw();report('unavailable');
      }
    },
    setVisible(value){visible=Boolean(value);element.style.display=visible?'':'none';report();},
    setComparison(id){const next=prepared?.comparisons.find(item=>item.id===id);if(!next)return false;desiredId=id;selected=next;draw();report();return true;},
    setOpacity(value){element.setAttribute('opacity',String(Math.max(0,Math.min(1,Number(value)||0))));},
    setUnit(unit){if(Number.isFinite(unit)&&unit>0)pattern.setAttribute('patternTransform',`scale(${unit})`);},
    update(nextBounds){bounds=nextBounds;report();},
    example,
    dispose(){disposed=true;requestId++;abort?.abort();heat.replaceChildren();unknown.replaceChildren();element.remove();}
  };
  return controller;
}
