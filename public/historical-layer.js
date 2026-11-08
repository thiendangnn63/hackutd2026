import {svgNode} from './ui.js';
const intersects=(a,b)=>a[0]<b[2]&&a[2]>b[0]&&a[1]<b[3]&&a[3]>b[1];
let historyRequest;
function history(force=false){
  if(force)historyRequest=null;
  if(!historyRequest)historyRequest=fetch('/api/houston/history').then(response=>{if(!response.ok)throw new Error('Historical imagery unavailable.');return response.json();}).catch(error=>{historyRequest=null;throw error;});
  return historyRequest;
}
export function createHistoricalLayer({project,unproject,onReady=()=>{},onStatus=()=>{}}){
  const element=svgNode('g',{class:'map-event-imagery','aria-hidden':'true','pointer-events':'none'}),unknown=svgNode('g',{class:'map-event-unknown'}),images=svgNode('g');element.append(unknown,images);element.style.display='none';
  let data=null,mode='aerial',selectedDate=null,view=null,size=null,disposed=false,sceneKey='',outsideCapture=false,failed=new Set();
  const nodes=new Map(),backdrop=svgNode('rect',{fill:'#182330','fill-opacity':.62});
  const rectangle=bbox=>{const a=project([bbox[0],bbox[3]]),b=project([bbox[2],bbox[1]]);return {x:a[0],y:a[1],width:b[0]-a[0],height:b[1]-a[1]};};
  const scenes=()=>mode==='radar'?(data?.radar?.available?[data.radar]:[]):mode==='flood'?(data?.flood.imagery||[]):['water','event-rgb'].includes(mode)?(data?.water.scenes||[]).filter(scene=>mode==='water'?scene.waterUrl:scene.rgbUrl):[];
  const selected=()=>scenes().find(scene=>scene.date===selectedDate)||scenes().find(scene=>scene.date==='2017-08-30')||scenes().find(scene=>scene.date>='2017-08-29')||scenes()[0];
  function report(){
    if(!['water','event-rgb','flood','radar'].includes(mode))return;
    const scene=selected();if(!scene)return onStatus({mode,source:'history-metadata',kind:'unavailable',label:'Historical imagery unavailable'});
    const empty=!outsideCapture&&nodes.size===0;
    const waiting=[...nodes.values()].some(item=>!item.loaded&&!item.error),error=[...nodes.values()].some(item=>item.error);
    const native=Math.min(Infinity,...[...nodes.values()].filter(item=>item.loaded&&Number.isFinite(item.source.sourceMetersPerPixel)).map(item=>item.source.sourceMetersPerPixel));
    const label=mode==='water'?`20 m water signal · ${scene.date}`:mode==='event-rgb'?`20 m Sentinel-2 · ${scene.date}`:mode==='radar'?`30 m radar proxy · ${scene.date}`:`${Number.isFinite(native)?'~'+(native<10?native.toFixed(1):Math.round(native))+' m aerial':'Flood-date aerial'} · ${scene.date}`;
    onStatus({mode,kind:error||empty?'unavailable':waiting?'loading':'ready',label:outsideCapture?'Outside capture · reference context':waiting?'Loading dated imagery…':label,date:scene.date,scene,outsideCapture});
  }
  const controller={element,
    async load(force=false){
      onStatus({mode,source:'history-metadata',kind:'loading'});
      try{const next=await history(force);if(disposed)return;data=next;onReady(controller);controller.update(view,size);}
      catch{if(!disposed)onStatus({mode,source:'history-metadata',kind:'unavailable',label:'Historical imagery unavailable'});}
    },
    get available(){return {water:Boolean(data?.water.scenes.some(scene=>scene.waterUrl)),rgb:Boolean(data?.water.scenes.some(scene=>scene.rgbUrl)),flood:Boolean(data?.flood.available),radar:Boolean(data?.radar?.available)};},
    dates(nextMode=mode){return (nextMode==='radar'?(data?.radar?.available?[data.radar]:[]):nextMode==='flood'?data?.flood.imagery:(data?.water.scenes||[]).filter(scene=>nextMode==='event-rgb'?scene.rgbUrl:scene.waterUrl))?.map(scene=>({value:scene.date,label:scene.date+(scene.date<'2017-08-25'?' · before Harvey':' · Harvey response')}))||[];},
    setMode(nextMode,date=selectedDate){mode=nextMode;selectedDate=date;sceneKey='';controller.update(view,size);return selected()?.date;},
    setDate(value){selectedDate=value;sceneKey='';controller.update(view,size);},
    hotspots(){return (data?.flood.imagery||[]).flatMap(scene=>scene.detail.map(asset=>({...asset,date:scene.date})));},
    retry(){if(!data)return controller.load(true);failed.clear();sceneKey='';controller.update(view,size);},
    update(nextView,nextSize){
      view=nextView;size=nextSize;if(disposed||!view||!size)return;
      const enabled=['water','event-rgb','flood','radar'].includes(mode);element.style.display=enabled?'':'none';
      if(!enabled){for(const item of nodes.values())item.image.remove();nodes.clear();unknown.replaceChildren();sceneKey='';return;}
      const scene=selected();if(!scene){report();return;}
      selectedDate=scene.date;
      const bbox=mode==='flood'?(scene.overview?.bbox||data.flood.bbox):scene.bbox;
      const key=mode+'|'+scene.id+'|'+scene.date;
      if(sceneKey!==key){
        for(const item of nodes.values())item.image.remove();nodes.clear();unknown.replaceChildren();
        unknown.append(backdrop);sceneKey=key;
      }
      const a=unproject([view.x,view.y+view.height]),b=unproject([view.x+view.width,view.y]),geoView=[a[0],a[1],b[0],b[1]];
      outsideCapture=!intersects(bbox,geoView);
      for(const rect of [backdrop])for(const [key,value]of Object.entries(view))rect.setAttribute(key,value);
      let sources=[];
      if(mode==='flood'){
        if(scene.overview)sources.push(scene.overview);
        if(geoView[2]-geoView[0]<.24)sources.push(...scene.detail.filter(asset=>intersects(asset.bbox,geoView)));
      }else{
        const url=mode==='radar'?scene.url:mode==='water'?scene.waterUrl:scene.rgbUrl;if(url)sources=[{id:mode+'-'+scene.id,url,bbox:scene.bbox,width:scene.width,height:scene.height}];
      }
      if(outsideCapture)sources=[];
      const wanted=new Set(sources.map(source=>source.url));
      for(const [url,item]of nodes)if(!wanted.has(url)){item.image.remove();nodes.delete(url);}
      for(const source of sources){
        if(nodes.has(source.url))continue;
        const image=svgNode('image',{...rectangle(source.bbox),href:source.url,preserveAspectRatio:'none',class:['water','radar'].includes(mode)?'map-water-image':'map-flood-image',opacity:0});image.dataset.eventImage=source.id||source.url;
        const item={image,source,loaded:false,error:failed.has(source.url)};nodes.set(source.url,item);if(item.error)continue;
        image.addEventListener('load',()=>{if(disposed||nodes.get(source.url)!==item)return;item.loaded=true;image.setAttribute('opacity','1');report();},{once:true});
        image.addEventListener('error',()=>{if(disposed||nodes.get(source.url)!==item)return;item.error=true;failed.add(source.url);image.remove();report();},{once:true});images.append(image);
      }
      const order=sources.map(source=>nodes.get(source.url)).filter(item=>item&&!item.error).map(item=>item.image);
      for(let i=0;i<order.length;i++)if(images.children[i]!==order[i])images.insertBefore(order[i],images.children[i]||null);
      report();
    },
    dispose(){disposed=true;for(const item of nodes.values())item.image.remove();nodes.clear();element.remove();}
  };
  return controller;
}
