import {svgNode} from './ui.js';
import {selectImageryTiles} from './imagery-model.js';

// Only the current geographic viewport is decoded; local overview images remain underneath.
export function createImageryDetailLayer({pyramid,project,unproject,onStatus=()=>{},isActive=()=>true}){
  const element=svgNode('g',{class:'map-detail-imagery','aria-hidden':'true','pointer-events':'none'}),nodes=new Map(),failed=new Set();
  let current=pyramid,lastView=null,lastSize=null,selection=null,disposed=false,refreshTimer=null,refreshing=false,enabled=true;
  const rectangle=bbox=>{const a=project([bbox[0],bbox[3]]),b=project([bbox[2],bbox[1]]);return {x:a[0],y:a[1],width:b[0]-a[0],height:b[1]-a[1]};};
  const report=()=>{
    if(!enabled){onStatus({kind:'hidden',label:'Boundaries only'});return;}
    if(!selection?.tiles.length){onStatus({kind:'overview',label:'Overview imagery'});return;}
    const pending=[...nodes.values()].filter(item=>!item.loaded&&!item.failed).length,errors=[...nodes.values()].filter(item=>item.failed).length;
    onStatus({kind:errors?'unavailable':pending?'loading':'ready',label:errors?'Detail unavailable · overview retained':pending?'Loading sharper imagery…':selection.resolutionLabel||'Detailed aerial imagery',pending,errors,level:selection.level});
  };
  async function refresh(){
    if(disposed||refreshing||current?.complete||!current?.downloading||!isActive())return scheduleRefresh();
    refreshing=true;
    try{const response=await fetch('/api/houston/imagery');if(response.ok){const next=await response.json();if(!disposed){current=next;controller.update(lastView,lastSize);}}}catch{/* Existing local imagery stays available. */}
    finally{refreshing=false;scheduleRefresh();}
  }
  function scheduleRefresh(){
    clearTimeout(refreshTimer);if(!disposed&&current?.downloading&&!current.complete)refreshTimer=setTimeout(refresh,10000);
  }
  const controller={element,
    update(view,size){
      lastView=view;lastSize=size;if(disposed||!view||!size)return;
      if(!enabled){for(const item of nodes.values())item.image.remove();nodes.clear();report();return;}
      const a=unproject([view.x,view.y+view.height]),b=unproject([view.x+view.width,view.y]);
      selection=selectImageryTiles(current,[a[0],a[1],b[0],b[1]],{...size,pixelRatio:Math.min(2,window.devicePixelRatio||1),maxTiles:size.width<=760?12:20,margin:size.width<=760?0:1});
      const requested=[...selection.fallbackTiles,...selection.tiles];
      const wanted=new Set(requested.map(tile=>tile.id));
      for(const [id,item]of nodes)if(!wanted.has(id)){item.image.remove();nodes.delete(id);}
      for(const tile of requested){
        if(nodes.has(tile.id)||typeof tile.url!=='string'||!tile.url.startsWith('/data/imagery/'))continue;
        const image=svgNode('image',{...rectangle(tile.bbox),href:tile.url,preserveAspectRatio:'none',class:'map-aerial map-detail-tile',opacity:0});
        image.dataset.tileId=tile.id;image.dataset.imageryLevel=tile.id.split('-r')[0];
        const item={image,loaded:false,failed:failed.has(tile.id)};nodes.set(tile.id,item);
        if(item.failed)continue;
        image.addEventListener('load',()=>{if(disposed||nodes.get(tile.id)!==item)return;item.loaded=true;image.setAttribute('opacity','1');report();},{once:true});
        image.addEventListener('error',()=>{if(disposed||nodes.get(tile.id)!==item)return;item.failed=true;failed.add(tile.id);image.remove();report();},{once:true});
        element.append(image);
      }
      const order=requested.map(tile=>nodes.get(tile.id)).filter(item=>item&&!item.failed).map(item=>item.image);
      for(let i=0;i<order.length;i++)if(element.children[i]!==order[i])element.insertBefore(order[i],element.children[i]||null);
      report();
    },
    setEnabled(value){enabled=Boolean(value);controller.update(lastView,lastSize);},
    retry(){failed.clear();for(const item of nodes.values())item.image.remove();nodes.clear();controller.update(lastView,lastSize);},
    dispose(){disposed=true;clearTimeout(refreshTimer);for(const item of nodes.values())item.image.remove();nodes.clear();element.remove();}
  };
  scheduleRefresh();return controller;
}
