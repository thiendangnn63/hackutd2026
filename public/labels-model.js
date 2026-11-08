import {normalize} from './records.js';

const finitePoint=p=>Array.isArray(p)&&p.length>=2&&p.slice(0,2).every(Number.isFinite);
const boundsOf=points=>points.reduce((b,[x,y])=>({x:Math.min(b.x,x),y:Math.min(b.y,y),right:Math.max(b.right,x),bottom:Math.max(b.bottom,y)}),{x:Infinity,y:Infinity,right:-Infinity,bottom:-Infinity});
export const labelBoxesOverlap=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
const pathLength=points=>points.slice(1).reduce((sum,p,i)=>sum+Math.hypot(p[0]-points[i][0],p[1]-points[i][1]),0);
export function prepareStreetLabels(collection,project){
  return (collection?.features||[]).flatMap((feature,index)=>{
    const name=feature.properties?.name,geometry=feature.geometry;
    if(typeof name!=='string'||!name.trim())return [];
    const lines=geometry?.type==='LineString'?[geometry.coordinates]:geometry?.type==='MultiLineString'?geometry.coordinates:[];
    const paths=lines.filter(line=>Array.isArray(line)&&line.length>1&&line.every(finitePoint)).map(line=>line.map(project));
    if(!paths.length)return [];
    const b=boundsOf(paths.flat());
    return [{id:feature.properties.id||feature.id||String(index),name,rank:Number(feature.properties.rank)||0,geometry,paths,bounds:{x:b.x,y:b.y,width:b.right-b.x,height:b.bottom-b.y}}];
  });
}
// Clip each segment to the viewport while keeping disconnected runs separate.
export function clippedStreetPaths(points,view){
  const runs=[];let run=[];
  const finish=()=>{if(run.length>1)runs.push(run);run=[];};
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],dx=b[0]-a[0],dy=b[1]-a[1];let lo=0,hi=1,valid=true;
    const p=[-dx,dx,-dy,dy],q=[a[0]-view.x,view.x+view.width-a[0],a[1]-view.y,view.y+view.height-a[1]];
    for(let edge=0;edge<4;edge++){
      if(!p[edge]){if(q[edge]<0)valid=false;continue;}
      const r=q[edge]/p[edge];if(p[edge]<0)lo=Math.max(lo,r);else hi=Math.min(hi,r);
    }
    if(!valid||lo>hi){finish();continue;}
    const start=[a[0]+lo*dx,a[1]+lo*dy],end=[a[0]+hi*dx,a[1]+hi*dy];
    if(run.length&&Math.hypot(run.at(-1)[0]-start[0],run.at(-1)[1]-start[1])>1e-7)finish();
    if(!run.length)run.push(start);run.push(end);
    if(hi<1)finish();
  }
  finish();return runs;
}
function along(points,distance){
  for(let i=1;i<points.length;i++){
    const a=points[i-1],b=points[i],length=Math.hypot(b[0]-a[0],b[1]-a[1]);
    if(distance<=length&&length)return [a[0]+(b[0]-a[0])*distance/length,a[1]+(b[1]-a[1])*distance/length];
    distance-=length;
  }
  return points.at(-1);
}
const degrees=(a,b)=>Math.atan2(b[1]-a[1],b[0]-a[0])*180/Math.PI;
const angleDelta=(a,b)=>Math.abs(((a-b+540)%360)-180);
export function chooseStreetLabels(streets,view,{unitsPerPixel=1,rankLimit=2,maxLabels=45,occupied=[]}={}){
  if(!(unitsPerPixel>0)||!Number.isFinite(unitsPerPixel))return [];
  const candidates=[];
  for(const street of streets){
    if(street.rank>rankLimit||!labelBoxesOverlap(street.bounds,view))continue;
    const width=(street.name.length*5.8+14)*unitsPerPixel,height=14*unitsPerPixel;
    for(const source of street.paths)for(const points of clippedStreetPaths(source,view)){
      const length=pathLength(points);if(length<width*1.12)continue;
      const distance=length/2,anchor=along(points,distance),start=along(points,distance-width/2),end=along(points,distance+width/2);
      const tangentA=degrees(start,anchor),tangentB=degrees(anchor,end);if(angleDelta(tangentA,tangentB)>30)continue;
      let angle=degrees(start,end);if(angle>90)angle-=180;if(angle<-90)angle+=180;
      const r=angle*Math.PI/180,w=Math.abs(Math.cos(r))*width+Math.abs(Math.sin(r))*height,h=Math.abs(Math.sin(r))*width+Math.abs(Math.cos(r))*height;
      const bounds={x:anchor[0]-w/2,y:anchor[1]-h/2,width:w,height:h};
      if(bounds.x<view.x||bounds.y<view.y||bounds.x+w>view.x+view.width||bounds.y+h>view.y+view.height)continue;
      candidates.push({id:street.id,name:street.name,rank:street.rank,x:anchor[0],y:anchor[1],angle,bounds,length});
    }
  }
  candidates.sort((a,b)=>a.rank-b.rank||b.length-a.length||a.name.localeCompare(b.name));
  const used=new Set(),placed=[],boxes=[...occupied];
  for(const label of candidates){
    const key=normalize(label.name);if(used.has(key)||boxes.some(box=>labelBoxesOverlap(box,label.bounds)))continue;
    placed.push(label);boxes.push(label.bounds);used.add(key);if(placed.length>=maxLabels)break;
  }
  return placed;
}
const roadWords={street:'st',road:'rd',avenue:'ave',boulevard:'blvd',drive:'dr',lane:'ln',court:'ct',circle:'cir',parkway:'pkwy',place:'pl',highway:'hwy',freeway:'fwy',expressway:'expy',trail:'trl',terrace:'ter',square:'sq',north:'n',south:'s',east:'e',west:'w',northeast:'ne',northwest:'nw',southeast:'se',southwest:'sw'};
const roadSearch=value=>normalize(value).split(' ').map(word=>Object.hasOwn(roadWords,word)?roadWords[word]:word.replace(/^(st|rd|ave|blvd|dr|ln|ct|cir|pkwy|pl|hwy|fwy|expy|trl|ter|sq)\.$/,'$1')).join(' ');

export function createGeographicSearchIndex(streets,landmarks){
  const grouped=new Map();
  for(const street of streets){
    let group=grouped.get(street.name);
    if(!group){
      group={id:street.id,name:street.name,rank:street.rank,referenceType:'street',
        geometry:{type:'MultiLineString',coordinates:[]},geoBounds:[Infinity,Infinity,-Infinity,-Infinity]};
      grouped.set(street.name,group);
    }
    group.rank=Math.min(group.rank,street.rank);
    const lines=street.geometry.type==='LineString'?[street.geometry.coordinates]:street.geometry.coordinates;
    for(const line of lines){
      group.geometry.coordinates.push(line);
      for(const [x,y] of line){
        const b=group.geoBounds;b[0]=Math.min(b[0],x);b[1]=Math.min(b[1],y);b[2]=Math.max(b[2],x);b[3]=Math.max(b[3],y);
      }
    }
  }
  const entries=[...landmarks.map(item=>({reference:{...item,referenceType:'landmark'},key:normalize(item.name)})),
    ...Array.from(grouped.values(),reference=>({reference,key:roadSearch(reference.name)}))];
  entries.sort((a,b)=>(a.reference.rank||0)-(b.reference.rank||0)||a.reference.name.localeCompare(b.reference.name));
  return entries;
}

export function geographicReferenceBounds(reference){
  if(reference.referenceType==='landmark'){
    const [x,y]=reference.point;return [x-.009,y-.007,x+.009,y+.007];
  }
  let [west,south,east,north]=reference.geoBounds;
  // Give a straight east-west or north-south street a finite camera rectangle.
  if(west===east){west-=.0005;east+=.0005;}
  if(south===north){south-=.0005;north+=.0005;}
  return [west,south,east,north];
}

export function searchGeographicIndex(index,query){
  const literal=normalize(query);if(!literal)return [];
  const street=roadSearch(literal),literalTerms=literal.split(' '),streetTerms=street.split(' ');
  const ranked=[[],[],[]];
  for(const {reference,key} of index){
    const isStreet=reference.referenceType==='street',terms=isStreet?streetTerms:literalTerms;
    if(!terms.every(term=>key.includes(term)))continue;
    const full=isStreet?street:literal,rank=key===full?0:key.startsWith(full)?1:2;
    ranked[rank].push(reference);
  }
  return ranked.flat();
}

export function searchGeographicReferences(streets,landmarks,query){
  return searchGeographicIndex(createGeographicSearchIndex(streets,landmarks),query);
}
