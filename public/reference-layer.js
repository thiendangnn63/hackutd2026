import {svgNode} from './ui.js';
import {prepareStreetLabels,chooseStreetLabels,labelBoxesOverlap,createGeographicSearchIndex,searchGeographicIndex,geographicReferenceBounds} from './labels-model.js';

let referenceData;
async function fetchReferences(force=false){
  if(force)referenceData=null;
  if(!referenceData)referenceData=Promise.all(['/data/houston-streets.json','/data/houston-landmarks.json','/data/houston-labels-meta.json'].map(async url=>{
    const response=await fetch(url);if(!response.ok)throw new Error('Map references unavailable.');return response.json();
  })).then(([streets,landmarks,metadata])=>{
    if(streets.type!=='FeatureCollection'||landmarks.type!=='FeatureCollection')throw new Error('Map references unavailable.');
    return {streets,landmarks,metadata};
  }).catch(error=>{referenceData=null;throw error;});
  return referenceData;
}
const boxInside=(box,view)=>box.x>=view.x&&box.y>=view.y&&box.x+box.width<=view.x+view.width&&box.y+box.height<=view.y+view.height;
export function createReferenceLayer({project,onReady=()=>{},onStatus=()=>{}}){
  const element=svgNode('g',{class:'map-reference-layer','aria-hidden':'true','pointer-events':'none'});
  const lines=svgNode('g',{class:'map-street-lines'}),labels=svgNode('g',{class:'map-reference-labels'});element.append(lines,labels);
  let streets=[],landmarks=[],searchIndex=[],disposed=false,showStreets=true,showLandmarks=true,previousRank=null,lastView=null,lastUnit=1,lastObstacles=[],ready=false;
  const roadPaths=[];
  const controller={element,occupied:[],metadata:null,
    async load(force=false){
      onStatus('loading');
      try{
        const data=await fetchReferences(force);if(disposed)return;
        streets=prepareStreetLabels(data.streets,project);
        landmarks=data.landmarks.features.flatMap((feature,index)=>{
          const p=feature.properties,point=feature.geometry?.coordinates;
          if(feature.geometry?.type!=='Point'||typeof p?.name!=='string'||!Array.isArray(point)||!point.slice(0,2).every(Number.isFinite))return [];
          const [x,y]=project(point);return [{...p,id:p.id||feature.id||String(index),point,x,y,rank:Number(p.rank)||0}];
        }).sort((a,b)=>a.rank-b.rank||({airport:0,park:1,civic:2,library:3}[a.kind]??4)-({airport:0,park:1,civic:2,library:3}[b.kind]??4)||a.name.localeCompare(b.name));
        searchIndex=createGeographicSearchIndex(streets,landmarks);
        lines.replaceChildren();roadPaths.length=0;
        for(const rank of [0,1,2]){
          const d=streets.filter(street=>street.rank===rank).flatMap(street=>street.paths.map(points=>points.map((p,i)=>`${i?'L':'M'}${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(''))).join('');
          const path=svgNode('path',{d,class:`map-road-line rank-${rank}`,fill:'none','vector-effect':'non-scaling-stroke'});lines.append(path);roadPaths.push(path);
        }
        previousRank=null;ready=true;controller.metadata=data.metadata;
        if(lastView)controller.update(lastView,lastUnit,lastObstacles);onStatus('ready');onReady();
      }catch{if(!disposed)onStatus('unavailable');}
    },
    setVisible({streets:roads=showStreets,landmarks:points=showLandmarks}={}){
      showStreets=roads;showLandmarks=points;previousRank=null;if(lastView)controller.update(lastView,lastUnit,lastObstacles);
    },
    search(query){return searchGeographicIndex(searchIndex,query);},
    bounds:geographicReferenceBounds,
    update(view,unit,obstacles=[]){
      lastView=view;lastUnit=unit;lastObstacles=obstacles;controller.occupied=[];
      if(!ready||disposed)return;
      const rank=unit>.85?-1:unit>.20?0:unit>.07?1:2;
      if(rank!==previousRank){for(const [i,path]of roadPaths.entries())path.style.display=showStreets&&i<=rank?'':'none';previousRank=rank;}
      labels.replaceChildren();const boxes=[...obstacles];
      if(showLandmarks){
        const allowed=unit>.5?0:unit>.16?1:2;
        const maximum=unit>.35?7:unit>.1?12:16,usedNames=new Set();
        let count=0;
        for(const landmark of landmarks){
          if(usedNames.has(landmark.name.toLocaleLowerCase())||(unit>.35&&landmark.name.length>38)||landmark.rank>allowed||landmark.x<view.x||landmark.x>view.x+view.width||landmark.y<view.y||landmark.y>view.y+view.height)continue;
          const pixelWidth=landmark.name.length*5.8+18,width=pixelWidth*unit,height=18*unit;
          for(const [dx,dy]of [[8,-7],[8,11],[-pixelWidth-8,-7],[-pixelWidth-8,11]]){
            const bounds={x:landmark.x+dx*unit,y:landmark.y+(dy-10)*unit,width,height};
            if(!boxInside(bounds,view)||boxes.some(box=>labelBoxesOverlap(box,bounds)))continue;
            const group=svgNode('g',{class:'map-landmark-label','data-reference-id':landmark.id});
            group.append(svgNode('circle',{cx:landmark.x,cy:landmark.y,r:2.6*unit,'stroke-width':unit}));
            const text=svgNode('text',{x:bounds.x+3*unit,y:bounds.y+12*unit,'font-size':11*unit,'stroke-width':3*unit});text.textContent=landmark.name;group.append(text);labels.append(group);
            boxes.push(bounds);controller.occupied.push(bounds);usedNames.add(landmark.name.toLocaleLowerCase());count++;break;
          }
          if(count>=maximum)break;
        }
      }
      if(showStreets&&rank>=0){
        const placed=chooseStreetLabels(streets,view,{unitsPerPixel:unit,rankLimit:rank,maxLabels:unit>.2?14:45,occupied:boxes});
        for(const label of placed){
          const text=svgNode('text',{class:'map-street-label',x:0,y:0,transform:`translate(${label.x} ${label.y}) rotate(${label.angle})`,'text-anchor':'middle','dominant-baseline':'middle','font-size':11*unit,'stroke-width':3*unit});text.textContent=label.name;labels.append(text);controller.occupied.push(label.bounds);
        }
      }
    },
    dispose(){disposed=true;element.remove();streets=[];landmarks=[];searchIndex=[];roadPaths.length=0;}
  };
  return controller;
}
