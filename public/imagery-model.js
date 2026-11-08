// Offline raster selection only: no network calls, no generated image pixels.
const METERS_PER_DEGREE=111320;
const validBox=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]<b[2]&&b[1]<b[3];
const intersects=(a,b)=>a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];
const localTile=t=>t?.available===true&&validBox(t.bbox)&&typeof t.url==='string'&&/^\/data\/imagery\/naip-l[0-3]-r\d{2}-c\d{2}\.webp$/.test(t.url);
const empty=()=>({level:null,requestedLevel:null,tier:null,tiles:[],fallbackTiles:[],metersPerPixel:null,targetMetersPerPixel:null,resolutionLabel:'Historical aerial context',needsRefresh:false});

export function selectImageryTiles(pyramid,geoBBox,{width,height,pixelRatio=1,maxTiles=40,margin=1}={}){
  const result=empty();
  if(!validBox(geoBBox)||!Number.isFinite(width)||!Number.isFinite(height)||width<=0||height<=0||!Array.isArray(pyramid?.tiers))return result;
  const ratio=Number.isFinite(pixelRatio)?Math.max(1,Math.min(2,pixelRatio)):1;
  const latitude=Math.max(-85,Math.min(85,(geoBBox[1]+geoBBox[3])/2));
  const target=Math.max((geoBBox[2]-geoBBox[0])*METERS_PER_DEGREE*Math.cos(latitude*Math.PI/180)/width,
    (geoBBox[3]-geoBBox[1])*METERS_PER_DEGREE/height)/ratio;
  result.targetMetersPerPixel=target;
  const tiers=pyramid.tiers.filter(t=>Number.isFinite(t.metersPerPixel)&&t.metersPerPixel>0&&Array.isArray(t.tiles)).slice().sort((a,b)=>b.metersPerPixel-a.metersPerPixel);
  if(!tiers.length)return result;
  let desired=tiers.findIndex(t=>t.metersPerPixel<=target);if(desired<0)desired=tiers.length-1;
  result.requestedLevel=tiers[desired].id;
  const pad=Number.isFinite(margin)?Math.max(0,Math.min(2,margin)):1;
  const limit=Number.isFinite(maxTiles)?Math.max(1,Math.min(80,Math.floor(maxTiles))):40;
  const center=[(geoBBox[0]+geoBBox[2])/2,(geoBBox[1]+geoBBox[3])/2];
  function visible(tier,availableOnly=true,includeMargin=true){
    const sample=tier.tiles.find(t=>validBox(t.bbox));if(!sample)return [];
    const dx=(sample.bbox[2]-sample.bbox[0])*(includeMargin?pad:0),dy=(sample.bbox[3]-sample.bbox[1])*(includeMargin?pad:0);
    const expanded=[geoBBox[0]-dx,geoBBox[1]-dy,geoBBox[2]+dx,geoBBox[3]+dy];
    return tier.tiles.filter(t=>(!availableOnly||localTile(t))&&validBox(t.bbox)&&intersects(t.bbox,expanded))
      .map((tile,index)=>({tile,index,distance:(((tile.bbox[0]+tile.bbox[2])/2-center[0])*Math.cos(latitude*Math.PI/180))**2+((tile.bbox[1]+tile.bbox[3])/2-center[1])**2}))
      .sort((a,b)=>a.distance-b.distance||a.index-b.index).map(({tile})=>tile);
  }
  const wanted=visible(tiers[desired],false,false);
  result.needsRefresh=Boolean(pyramid.downloading&&wanted.some(t=>!localTile(t)));
  let selected=desired,tiles=[];
  while(selected>=0){if(visible(tiers[selected],true,false).length){tiles=visible(tiers[selected]);break;}selected--;}
  if(selected<0)return result;
  result.level=tiers[selected].id;result.tier=tiers[selected];result.tiles=tiles.slice(0,limit);
  result.metersPerPixel=tiers[selected].metersPerPixel;
  result.resolutionLabel=`~${result.metersPerPixel>=10?Math.round(result.metersPerPixel):result.metersPerPixel.toFixed(1)} m/px · historical aerial`;
  // Optional lower-resolution support, capped together with the selected tile set.
  const fallbacks=[];let remaining=Math.max(0,limit-result.tiles.length);
  for(let i=selected-1;i>=0&&remaining>0;i--){const chosen=visible(tiers[i]).slice(0,remaining);fallbacks.unshift(...chosen);remaining-=chosen.length;}
  result.fallbackTiles=fallbacks;
  return result;
}
