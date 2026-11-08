// Offline planning fixtures. Coordinates below are synthesized, never geocoded reports.
export const NEED_TYPES = ['medical', 'evacuation', 'supplies', 'other'];
export const geometryOf = value => value?.type === 'Feature' ? value.geometry : value;
export function geometryBounds(value) {
  const g = geometryOf(value);
  const points = (g?.type === 'Polygon' ? g.coordinates : g?.type === 'MultiPolygon' ? g.coordinates.flat() : []).flat();
  if (!points.length) return null;
  return points.reduce((b, [x,y]) => [Math.min(b[0],x),Math.min(b[1],y),Math.max(b[2],x),Math.max(b[3],y)], [Infinity,Infinity,-Infinity,-Infinity]);
}
function inRing([x,y], ring) {
  let inside = false;
  for (let i=0,j=ring.length-1; i<ring.length; j=i++) {
    const [xi,yi]=ring[i], [xj,yj]=ring[j];
    if ((yi>y)!==(yj>y) && x<(xj-xi)*(y-yi)/(yj-yi)+xi) inside=!inside;
  }
  return inside;
}
export function insideGeometry(point, value) {
  const g=geometryOf(value);
  const polygons=g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'?g.coordinates:[];
  return polygons.some(p=>inRing(point,p[0])&&!p.slice(1).some(r=>inRing(point,r)));
}
function clippedRing(ring,bounds) {
  let output=ring;
  for(const [axis,limit,sign]of [[0,bounds[0],1],[0,bounds[2],-1],[1,bounds[1],1],[1,bounds[3],-1]]){
    const input=output;output=[];
    if(!input.length)break;
    for(let i=0,j=input.length-1;i<input.length;j=i++){
      const a=input[j],b=input[i],ain=sign*(a[axis]-limit)>=0,bin=sign*(b[axis]-limit)>=0;
      if(ain!==bin){const t=(limit-a[axis])/(b[axis]-a[axis]);output.push([a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]);}
      if(bin)output.push(b);
    }
  }
  return output;
}
export function hasIntersection(bounds,value) {
  const g=geometryOf(value),polygons=g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'?g.coordinates:[];
  const area=ring=>{let sum=0;for(let i=0,j=ring.length-1;i<ring.length;j=i++)sum+=ring[j][0]*ring[i][1]-ring[i][0]*ring[j][1];return Math.abs(sum)/2;};
  return polygons.some(p=>p.reduce((sum,ring,i)=>sum+(i?-1:1)*area(clippedRing(ring,bounds)),0)>1e-12);
}
export function hash(value) {
  let h=2166136261;
  for(const c of String(value)) { h^=c.charCodeAt(0); h=Math.imul(h,16777619); }
  return h>>>0;
}
export function demoLocations(region) {
  const bounds=geometryBounds(region.geometry);
  if(!bounds) return [];
  let seed=hash(region.id);
  const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
  const points=[];
  for(let i=0;i<region.openCount;i++) {
    let point=null;
    for(let attempt=0;attempt<5000;attempt++) {
      const p=[bounds[0]+random()*(bounds[2]-bounds[0]),bounds[1]+random()*(bounds[3]-bounds[1])];
      if(insideGeometry(p,region.geometry)){point=p;break;}
    }
    // Failure stays explicitly unplaced instead of inventing an out-of-bound coordinate.
    points.push({point,categories:NEED_TYPES.filter(c=>i<(region.categories?.[c]||0))});
  }
  return points;
}
export function hospitalityFixture(id) {
  const h=hash(id);
  if(h%7===0) return {score:null,capacity:null,power:null,water:null,access:null};
  const power=!!(h&1),water=!!(h&2),access=!!(h&4);
  return {score:Math.round((Number(power)+Number(water)+Number(access))/3*100),capacity:20+h%180,power,water,access};
}
export function buildSubtiles(region, level, locations=demoLocations(region)) {
  const bounds=geometryBounds(region.geometry);
  if(!bounds) return [];
  const n=2**Math.max(0,Math.min(2,level));
  const cells=[];
  for(let row=0;row<n;row++) for(let col=0;col<n;col++) {
    const id=`${region.id}/${level}/${col}/${row}`;
    const west=bounds[0]+(bounds[2]-bounds[0])*col/n,east=bounds[0]+(bounds[2]-bounds[0])*(col+1)/n;
    const south=bounds[1]+(bounds[3]-bounds[1])*row/n,north=bounds[1]+(bounds[3]-bounds[1])*(row+1)/n;
    cells.push({id,regionId:region.id,name:level?`${region.name} · ${String.fromCharCode(65+col)}${row+1}`:region.name,
      bounds:[west,south,east,north],hasArea:hasIntersection([west,south,east,north],region.geometry),openCount:0,categories:Object.fromEntries(NEED_TYPES.map(c=>[c,0])),hospitality:hospitalityFixture(id)});
  }
  for(const {point,categories} of locations) {
    if(!point) continue;
    const col=Math.min(n-1,Math.max(0,Math.floor((point[0]-bounds[0])/(bounds[2]-bounds[0])*n)));
    const row=Math.min(n-1,Math.max(0,Math.floor((point[1]-bounds[1])/(bounds[3]-bounds[1])*n)));
    const cell=cells[row*n+col];cell.openCount++;
    categories.forEach(c=>cell.categories[c]++);
  }
  return cells;
}
export const detailLevel = zoom => zoom>=5?2:zoom>=2.2?1:0;

// Free-panning camera; view dimensions follow the actual map, avoiding letterboxing.
export function cameraView(camera, width, height) {
  const w=800/camera.zoom,h=w*height/Math.max(1,width);
  return {x:camera.x-w/2,y:camera.y-h/2,width:w,height:h};
}
export function zoomAt(camera, factor, point={x:camera.x,y:camera.y}) {
  const current={x:Number.isFinite(camera.x)?camera.x:400,y:Number.isFinite(camera.y)?camera.y:315,
    zoom:Number.isFinite(camera.zoom)?Math.min(24,Math.max(.4,camera.zoom)):1};
  if(!Number.isFinite(factor)||factor<=0)return current;
  if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))point=current;
  const zoom=Math.min(24,Math.max(.4,current.zoom*factor));
  return {zoom,x:point.x-(point.x-current.x)*current.zoom/zoom,y:point.y-(point.y-current.y)*current.zoom/zoom};
}
export function startGesture(camera, points, worldPoint, unit) {
  const [a,b=a]=points,center={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
  return {camera:{...camera},center,anchor:worldPoint(center.x,center.y),unit,distance:points.length>1?Math.hypot(a.x-b.x,a.y-b.y):0,moved:points.length>1};
}
export function moveGesture(gesture, points) {
  const [a,b=a]=points,center={x:(a.x+b.x)/2,y:(a.y+b.y)/2};
  const dx=center.x-gesture.center.x,dy=center.y-gesture.center.y;
  if(Math.hypot(dx,dy)>5||points.length>1) gesture.moved=true;
  if(!gesture.moved)return gesture.camera;
  const next=zoomAt(gesture.camera,points.length>1&&gesture.distance?Math.hypot(a.x-b.x,a.y-b.y)/gesture.distance:1,gesture.anchor);
  return {...next,x:next.x-dx*gesture.unit*gesture.camera.zoom/next.zoom,y:next.y-dy*gesture.unit*gesture.camera.zoom/next.zoom};
}
