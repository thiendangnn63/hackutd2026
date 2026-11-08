import {node} from './ui.js';
import {prepareObservationCoverage,observationCoverage,suggestObservationDate} from './map-coverage.js';

// Observation availability describes the selected date and current map view.
// It never classifies flooding or changes the date without an explicit action.
export function createObservationView(root,{onDate=()=>{},onShow=()=>{},onFocusMap=()=>{},onLayout=()=>{}}={}){
  const heading=node('span','observation-heading'),detail=node('span','observation-detail'),action=node('button','observation-action text-button');
  action.type='button';root.replaceChildren(heading,detail,action);root.hidden=true;action.hidden=true;
  let compiled=null,loadState='idle',request=null,requestId=0,latest=null,lastPaint='',nextAction=null,renderTimer=null,identity='';
  const text=(element,value)=>{if(element.textContent!==value)element.textContent=value;};
  const dateLabel=date=>new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',timeZone:'UTC'}).format(new Date(date+'T12:00:00Z'));
  function paint({state='hidden',label='',description='',actionLabel='',perform=null}={}){
    const stamp=JSON.stringify([state,label,description,actionLabel]);nextAction=perform;
    if(stamp===lastPaint)return;
    lastPaint=stamp;
    const hadFocus=document.activeElement===action;
    root.dataset.coverageState=state;root.hidden=state==='hidden';
    text(heading,label);text(detail,description);detail.hidden=!description;
    text(action,actionLabel);action.hidden=!actionLabel;
    if(hadFocus&&(root.hidden||action.hidden))onFocusMap();
    onLayout();
  }
  function render(){
    const state=latest;
    if(!state||!['water','event-rgb'].includes(state.mode)||!state.bbox)return paint();
    if(state.opacity===0)return paint({state:'hidden-layer',label:'Satellite imagery is hidden',description:'Imagery opacity is 0%.',actionLabel:'Show imagery',perform:onShow});
    if(state.imageState==='unavailable')return paint({state:'image-error',label:'Satellite image unavailable',description:'Open Imagery to retry the dated image.'});
    if(state.imageState==='loading')return paint({state:'image-loading',label:'Loading satellite image…'});
    if(loadState==='loading'||loadState==='idle')return paint({state:'loading',label:'Checking observations in this view…'});
    if(!compiled)return paint({state:'unavailable',label:'Observation coverage unavailable',description:'The dated imagery can still be viewed.',actionLabel:'Retry coverage',perform:()=>load(true)});
    const coverage=observationCoverage(compiled,state.bbox,state.date);
    if(!coverage.available)return paint({state:'unavailable',label:'Observation coverage unavailable',description:'Coverage for this capture could not be read.',actionLabel:'Retry coverage',perform:()=>load(true)});
    const suggestion=suggestObservationDate(compiled,state.bbox,state.date,{notBefore:'2017-08-25',minGain:.1,minCoverage:.2,allowedDates:state.dates});
    const alternate=suggestion?{actionLabel:'Try '+dateLabel(suggestion.date),perform:()=>onDate(suggestion.date)}:{};
    if(coverage.outsideFraction>=1-1e-9)return paint({state:'outside',label:'Outside Sentinel-2 coverage',description:'Reference context · flood status unknown'});
    if(coverage.upperFraction===0)return paint({state:'obscured',label:'No clear observation here',description:'Reference context · flood status unknown',...alternate});
    const lower=coverage.lowerFraction,upper=coverage.upperFraction,percent=Math.round(coverage.knownFraction*100);
    const label=upper-lower>.25?'Partial observations in this view':percent===0?'Sparse observations in this view':'About '+percent+'% observed in this view';
    const description=coverage.outsideFraction>.02?'Includes areas outside the capture':lower<.95?'Unobserved areas remain unknown':'';
    paint({state:lower>=.95?'clear':'partial',label,description,...alternate});
  }
  async function load(force=false){
    if(request&&!force)return request;
    if(compiled&&!force)return;
    const id=++requestId;loadState='loading';render();
    request=(async()=>{
      try{
        const response=await fetch('/data/houston-observation-coverage.json');if(!response.ok)throw new Error('Coverage unavailable');
        const value=prepareObservationCoverage(await response.json());if(!value)throw new Error('Coverage unreadable');
        if(id!==requestId)return;
        compiled=value;loadState='ready';
      }catch{if(id===requestId){compiled=null;loadState='unavailable';}}
      finally{if(id===requestId){request=null;render();}}
    })();
    return request;
  }
  action.addEventListener('click',()=>nextAction?.());
  return {update(state){
    latest=state;const nextIdentity=JSON.stringify([state?.mode,state?.date,state?.imageState,state?.opacity]);
    clearTimeout(renderTimer);
    if(nextIdentity!==identity){identity=nextIdentity;render();}else renderTimer=setTimeout(render,120);
    if(['water','event-rgb'].includes(state?.mode)&&loadState==='idle')load();
  }};
}
