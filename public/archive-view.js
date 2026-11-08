import {node,button} from './ui.js';

const IMAGE_PREFIX='/api/satellite/images/';
const CREDIT='Historical xBD / xView2 · Maxar imagery · Gupta et al., DIU, CMU SEI and collaborators · CC BY-NC-SA 4.0. Individual capture dates and geographic placement on the Houston dashboard are not established.';

// The API serves a fixed allowlist of PNG basenames. Reject URLs outside that
// contract before assigning an img src, including malformed and missing values.
export function archiveImageUrl(source,origin){
  if(typeof source!=='string'||!source||source.trim()!==source||/[\\\u0000-\u001f\u007f]/.test(source))return null;
  try{
    const base=new URL(origin),url=new URL(source,base.origin);
    if(!['http:','https:'].includes(url.protocol)||url.origin!==base.origin||url.username||url.password||url.search||url.hash||!url.pathname.startsWith(IMAGE_PREFIX))return null;
    const name=decodeURIComponent(url.pathname.slice(IMAGE_PREFIX.length));
    if(!/^[a-zA-Z0-9_-]+\.png$/.test(name))return null;
    return new URL(IMAGE_PREFIX+encodeURIComponent(name),base.origin).href;
  }catch{return null;}
}

// Readiness is a pair-level decision: a single successful image is insufficient.
// A generation also prevents an old pair's late load/error from changing the UI.
export function createArchiveImageState(){
  let generation=0,state={generation,phase:'idle',before:'idle',after:'idle'};
  const snapshot=()=>({...state});
  return {
    begin(){generation++;state={generation,phase:'loading',before:'loading',after:'loading'};return generation;},
    invalidate(){generation++;state={generation,phase:'idle',before:'idle',after:'idle'};return snapshot();},
    settle(token,side,success){
      if(token!==generation||state.phase!=='loading'||!['before','after'].includes(side)||state[side]!=='loading')return snapshot();
      state={...state,[side]:success?'ready':'error'};
      if(!success)state.phase='error';
      else if(state.before==='ready'&&state.after==='ready')state.phase='ready';
      return snapshot();
    },
    snapshot
  };
}

function feedback(heading,description){
  const element=node('div','empty-state archive-feedback');
  element.append(node('h3','',heading),node('p','',description));
  return element;
}

function archiveTiles(data){
  if(!data||data.available!==true||!Array.isArray(data.tiles))return [];
  const seen=new Set();
  return data.tiles.filter(tile=>{
    if(!tile||typeof tile.id!=='string'||!tile.id.trim()||seen.has(tile.id))return false;
    seen.add(tile.id);return true;
  });
}

// Empty/unavailable inventories do not erase the last explicit study choice.
export function archiveSelectedId(tiles,current){
  return tiles.length?(tiles.some(tile=>tile.id===current)?current:tiles[0].id):current;
}

export function createArchiveView(root){
  if(!root||typeof root.replaceChildren!=='function')throw new TypeError('An archive root element is required.');
  const doc=root.ownerDocument,origin=doc.defaultView.location.origin;
  const imageState=createArchiveImageState();
  let initialized=false,data=null,tiles=[],selectedId=null,comparison=50;
  let request=0,requestController=null,pendingLoad=null,metadataLoading=false;
  let pairCleanup=()=>{},currentImages=null,dragPointer=null;

  const toolbar=node('div','archive-toolbar'),label=node('label','','Historical image pair');
  const select=node('select');select.setAttribute('aria-label','Historical image pair');select.dataset.archiveControl='pair';label.append(select);
  toolbar.append(label,node('span','pill','Separate study areas · not georeferenced to Houston'));
  const status=node('p','archive-status workspace-note');status.id=(root.id||'archive')+'-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.setAttribute('aria-atomic','true');
  const pair=node('div','archive-pair');pair.setAttribute('role','group');pair.setAttribute('aria-label','Historical before and after imagery');pair.setAttribute('aria-describedby',status.id);pair.style.touchAction='pan-y';
  const slider=node('div','archive-slider'),sliderLabels=node('label');sliderLabels.setAttribute('aria-hidden','true');sliderLabels.append(node('span','','Before'),node('span','','Drag to compare'),node('span','','After'));
  const range=node('input');range.type='range';range.min='0';range.max='100';range.step='1';range.setAttribute('aria-label','Before and after imagery comparison');range.setAttribute('aria-describedby',status.id);range.dataset.archiveControl='comparison';slider.append(sliderLabels,range);
  const actions=node('div','archive-actions');
  const retry=button('Retry pair',()=>startPair(true),'control archive-retry');retry.dataset.archiveControl='retry';retry.hidden=true;
  const refresh=button('Refresh archive',()=>load(true),'control archive-refresh');refresh.dataset.archiveControl='refresh';
  actions.append(retry,refresh);
  const empty=node('div','archive-empty');empty.hidden=true;
  const credit=node('p','archive-credit',CREDIT);

  function setStatus(message,state){status.textContent=message;root.dataset.archiveState=state;}
  function stopPair(){pairCleanup();pairCleanup=()=>{};imageState.invalidate();currentImages=null;dragPointer=null;range.disabled=true;pair.setAttribute('aria-busy','false');}
  function setPairPhase(phase){pair.classList.remove('is-loading','is-error','is-ready');pair.classList.add('is-'+phase);pair.setAttribute('aria-busy',String(phase==='loading'));}
  function updateComparison(value){
    const number=Number(value);if(Number.isFinite(number))comparison=Math.max(0,Math.min(100,number));
    range.value=String(comparison);range.setAttribute('aria-valuetext',`${comparison}% before image, ${100-comparison}% after image`);
    if(currentImages&&imageState.snapshot().phase==='ready'){
      currentImages.after.style.clipPath=`inset(0 0 0 ${comparison}%)`;
      currentImages.divider.style.left=`${comparison}%`;
    }
  }
  function setRetryLoading(loading){
    retry.textContent=loading?'Retrying pair…':'Retry pair';
    if(loading)retry.setAttribute('aria-disabled','true');else retry.removeAttribute('aria-disabled');
  }
  function showUnavailable(heading,description){
    stopPair();pair.hidden=true;slider.hidden=true;retry.hidden=true;setRetryLoading(false);empty.hidden=false;empty.replaceChildren(feedback(heading,description));
    setStatus(description,'unavailable');
  }
  function failPair(message){
    range.disabled=true;currentImages=null;setPairPhase('error');pair.replaceChildren(feedback('Image pair unavailable',message));retry.hidden=false;setRetryLoading(false);
    setStatus(message+' Retry this pair, choose another study area, or refresh the archive.','error');
  }
  function startPair(isRetry=false){
    if(metadataLoading||(isRetry&&retry.getAttribute('aria-disabled')==='true'))return;
    stopPair();
    const tile=tiles.find(item=>item.id===selectedId);if(!tile)return;
    empty.hidden=true;pair.hidden=false;slider.hidden=false;
    retry.hidden=!isRetry;setRetryLoading(isRetry);setPairPhase('loading');pair.replaceChildren(feedback('Loading image pair','Waiting for both the before and after images.'));
    updateComparison(comparison);setStatus('Loading both historical images. Comparison is available when both are ready.','loading-pair');
    const beforeSource=archiveImageUrl(tile.preImageUrl,origin),afterSource=archiveImageUrl(tile.postImageUrl,origin);
    if(!beforeSource||!afterSource){failPair('The archive is missing a valid local '+(!beforeSource&&!afterSource?'before and after image URL':!beforeSource?'before image URL':'after image URL')+'.');return;}
    const token=imageState.begin(),before=node('img'),after=node('img','archive-after'),divider=node('div','archive-divider');
    divider.append(node('span','','↔'));
    before.alt=`Before Hurricane Harvey, historical study image ${tile.id}`;after.alt=`After Hurricane Harvey, historical study image ${tile.id}`;before.draggable=false;after.draggable=false;
    const listeners=[];
    const settle=(side,image,success)=>{
      if(imageState.snapshot().generation!==token||metadataLoading)return;
      const state=imageState.settle(token,side,success&&image.naturalWidth>0&&image.naturalHeight>0);
      if(state.phase==='error'){
        pairCleanup();pairCleanup=()=>{};
        failPair(`The ${side==='before'?'before':'after'} image could not be loaded.`);
      }else if(state.phase==='ready'){
        pairCleanup();pairCleanup=()=>{};
        if(before.naturalWidth!==after.naturalWidth||before.naturalHeight!==after.naturalHeight){failPair('The before and after images have different dimensions and cannot be compared.');return;}
        const moveRetryFocus=doc.activeElement===retry;
        pair.style.aspectRatio=`${before.naturalWidth} / ${before.naturalHeight}`;
        pair.replaceChildren(before,after,divider,node('span','archive-label before','Before · Harvey 2017'),node('span','archive-label after','After · Harvey 2017'));
        currentImages={before,after,divider};range.disabled=false;setPairPhase('ready');updateComparison(comparison);
        setStatus('Both historical images are ready. Use the comparison slider or drag the image to compare.','ready');
        if(moveRetryFocus)range.focus({preventScroll:true});
        retry.hidden=true;setRetryLoading(false);
      }
    };
    for(const [side,image,source] of [['before',before,beforeSource],['after',after,afterSource]]){
      const loaded=()=>settle(side,image,true),failed=()=>settle(side,image,false);
      image.addEventListener('load',loaded,{once:true});image.addEventListener('error',failed,{once:true});
      listeners.push(()=>{image.removeEventListener('load',loaded);image.removeEventListener('error',failed);});
      // Attach listeners before src so even an already-cached image is observed.
      image.src=source;
    }
    pairCleanup=()=>{for(const remove of listeners)remove();};
  }
  select.addEventListener('change',()=>{selectedId=select.value;startPair();});
  range.addEventListener('input',()=>{if(!range.disabled)updateComparison(range.value);});
  const compare=event=>{const bounds=pair.getBoundingClientRect();if(bounds.width>0)updateComparison(Math.round((event.clientX-bounds.left)/bounds.width*100));};
  pair.addEventListener('pointerdown',event=>{
    if(range.disabled||event.isPrimary===false||(event.button!==undefined&&event.button!==0))return;
    dragPointer=event.pointerId;range.focus({preventScroll:true});
    try{pair.setPointerCapture(event.pointerId);}catch{/* A canceled pointer is handled by the end listeners. */}
    compare(event);
  });
  pair.addEventListener('pointermove',event=>{if(event.pointerId===dragPointer&&!range.disabled)compare(event);});
  for(const name of ['pointerup','pointercancel','lostpointercapture'])pair.addEventListener(name,()=>{dragPointer=null;});

  async function load(force=false){
    if(!initialized){initialized=true;root.replaceChildren(toolbar,status,empty,pair,slider,actions,credit);pair.hidden=true;slider.hidden=true;updateComparison(comparison);}
    if(!force){if(pendingLoad)return pendingLoad;if(data!==null)return;}
    const moveControlFocus=[select,range,retry].includes(doc.activeElement);
    const token=++request;requestController?.abort();requestController=new AbortController();metadataLoading=true;
    stopPair();pair.hidden=true;slider.hidden=true;empty.hidden=false;empty.replaceChildren(feedback('Loading the historical archive','Checking the local image-pair inventory.'));
    retry.hidden=true;setRetryLoading(false);select.disabled=true;label.hidden=!tiles.length;refresh.textContent='Refreshing archive…';refresh.setAttribute('aria-busy','true');
    if(moveControlFocus)refresh.focus({preventScroll:true});
    setStatus('Loading the historical archive.','loading-archive');
    const operation=(async()=>{
      try{
        const response=await doc.defaultView.fetch('/api/satellite',{signal:requestController.signal,cache:'no-store'});
        if(!response.ok)throw new Error('The historical archive could not be loaded.');
        const result=await response.json();if(token!==request)return;
        if(!result||typeof result!=='object'||typeof result.available!=='boolean'||(result.available&&!Array.isArray(result.tiles)))throw new Error('The archive returned an invalid image-pair inventory.');
        data=result;tiles=archiveTiles(data);metadataLoading=false;select.disabled=false;
        const previous=selectedId;selectedId=archiveSelectedId(tiles,selectedId);
        select.replaceChildren();for(const [index,tile] of tiles.entries()){
          const option=node('option','',`Harvey 2017 · study area ${index+1} · ${tile.id.split('_').at(-1)}`);option.value=tile.id;select.append(option);
        }
        select.value=selectedId??'';label.hidden=!tiles.length;
        if(!tiles.length){showUnavailable('No archived image pairs available',typeof data.reason==='string'&&data.reason?data.reason:'Import a verified historical model bundle to compare its image pairs.');return;}
        startPair();
        if(previous&&previous!==selectedId)setStatus('The previous pair is no longer in the archive. Loading the first available pair.','loading-pair');
      }catch(error){
        if(token!==request)return;
        metadataLoading=false;data=data??{available:false};
        label.hidden=!tiles.length;select.disabled=true;
        showUnavailable('Archive unavailable',error instanceof Error?error.message:'The historical archive could not be loaded.');
      }finally{
        if(token===request){metadataLoading=false;pendingLoad=null;refresh.textContent='Refresh archive';refresh.removeAttribute('aria-busy');}
      }
    })();
    pendingLoad=operation;return operation;
  }
  return {load};
}
