// Observation coverage only. A valid non-water observation is still observed;
// a missing observation never establishes dry ground or safety.
const states=new WeakMap();
const finiteExtent=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]>=-180&&b[2]<=180&&b[1]>=-90&&b[3]<=90&&b[0]<b[2]&&b[1]<b[3];
const validDate=d=>typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T00:00:00Z'))&&new Date(d+'T00:00:00Z').toISOString().slice(0,10)===d;
const clamp=n=>Math.max(0,Math.min(1,n));
const snap=n=>Math.abs(n-Math.round(n))<1e-9?Math.round(n):n;
const unavailable=date=>({available:false,status:'unavailable',date:validDate(date)?date:null,knownFraction:null,lowerFraction:null,upperFraction:null,outsideFraction:null,approximate:false,knownPixelsEstimate:null,exactKnownPixels:null,totalPixels:null,insidePixels:null});

// Compile once after the local JSON fetch. Input arrays are validated and copied;
// the opaque frozen handle keeps callers from modifying the prefix sums.
export function prepareObservationCoverage(raw){
  if(!raw||raw.schemaVersion!==1||raw.crs!=='EPSG:4326'||raw.encoding!=='observed-pixel-counts'||!Number.isInteger(raw.blockSize)||raw.blockSize<1||raw.blockSize>256||!Array.isArray(raw.scenes)||!raw.scenes.length||raw.scenes.length>12)return null;
  const block=raw.blockSize,scenes=new Map();
  for(const scene of raw.scenes){
    const {width,height}=scene||{};
    if(!validDate(scene?.date)||scenes.has(scene.date)||!finiteExtent(scene.bbox)||!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>10000||height>10000)return null;
    const columns=Math.ceil(width/block),rows=Math.ceil(height/block);
    if(columns*rows>1_000_000||scene.columns!==columns||scene.rows!==rows||!Array.isArray(scene.counts)||scene.counts.length!==columns*rows)return null;
    const counts=new Uint32Array(scene.counts.length),prefix=new Float64Array((columns+1)*(rows+1));let total=0;
    for(let row=0;row<rows;row++){
      let rowSum=0;
      for(let col=0;col<columns;col++){
        const index=row*columns+col,value=scene.counts[index],area=Math.min(block,width-col*block)*Math.min(block,height-row*block);
        if(!Number.isInteger(value)||value<0||value>area)return null;
        counts[index]=value;total+=value;rowSum+=value;prefix[(row+1)*(columns+1)+col+1]=prefix[row*(columns+1)+col+1]+rowSum;
      }
    }
    if(!Number.isInteger(scene.knownPixels)||scene.knownPixels!==total)return null;
    scenes.set(scene.date,{date:scene.date,bbox:[...scene.bbox],width,height,columns,rows,counts,prefix,block});
  }
  const handle=Object.freeze({schemaVersion:1,blockSize:block,dates:Object.freeze([...scenes.keys()].sort())});states.set(handle,scenes);return handle;
}

export function observationCoverage(prepared,bounds,date){
  const scene=states.get(prepared)?.get(date);if(!scene||!finiteExtent(bounds))return unavailable(date);
  const {bbox,width,height,columns,rows,counts,prefix,block}=scene;
  const x0=snap((bounds[0]-bbox[0])/(bbox[2]-bbox[0])*width),x1=snap((bounds[2]-bbox[0])/(bbox[2]-bbox[0])*width);
  const y0=snap((bbox[3]-bounds[3])/(bbox[3]-bbox[1])*height),y1=snap((bbox[3]-bounds[1])/(bbox[3]-bbox[1])*height);
  const totalPixels=(x1-x0)*(y1-y0);if(!Number.isFinite(totalPixels)||totalPixels<=0)return unavailable(date);
  const left=Math.max(0,x0),right=Math.min(width,x1),top=Math.max(0,y0),bottom=Math.min(height,y1),insidePixels=Math.max(0,right-left)*Math.max(0,bottom-top);
  const outsideFraction=clamp(1-insidePixels/totalPixels);
  if(!insidePixels)return {available:true,status:'outside',date,knownFraction:0,lowerFraction:0,upperFraction:0,outsideFraction:1,approximate:false,knownPixelsEstimate:0,exactKnownPixels:0,totalPixels,insidePixels:0};
  const c0=Math.floor(left/block),c1=Math.min(columns,Math.ceil(right/block)),r0=Math.floor(top/block),r1=Math.min(rows,Math.ceil(bottom/block));
  const fc0=Math.ceil(left/block),fc1=right===width?columns:Math.floor(right/block),fr0=Math.ceil(top/block),fr1=bottom===height?rows:Math.floor(bottom/block);
  const hasFull=fc0<fc1&&fr0<fr1,stride=columns+1;
  let estimated=0,lower=0,upper=0;
  if(hasFull)estimated=lower=upper=prefix[fr1*stride+fc1]-prefix[fr0*stride+fc1]-prefix[fr1*stride+fc0]+prefix[fr0*stride+fc0];
  function partial(row,col){
    const cellLeft=col*block,cellTop=row*block,cellRight=Math.min(width,cellLeft+block),cellBottom=Math.min(height,cellTop+block);
    const area=(cellRight-cellLeft)*(cellBottom-cellTop),overlap=Math.max(0,Math.min(right,cellRight)-Math.max(left,cellLeft))*Math.max(0,Math.min(bottom,cellBottom)-Math.max(top,cellTop));
    const known=counts[row*columns+col];estimated+=known*overlap/area;lower+=Math.max(0,known-(area-overlap));upper+=Math.min(known,overlap);
  }
  for(let row=r0;row<r1;row++){
    if(hasFull&&row>=fr0&&row<fr1){for(let col=c0;col<fc0;col++)partial(row,col);for(let col=fc1;col<c1;col++)partial(row,col);}
    else for(let col=c0;col<c1;col++)partial(row,col);
  }
  const knownFraction=clamp(estimated/totalPixels),lowerFraction=clamp(lower/totalPixels),upperFraction=clamp(upper/totalPixels),approximate=upperFraction-lowerFraction>1e-12;
  const exactKnownPixels=!approximate&&[x0,x1,y0,y1].every(Number.isInteger)&&Number.isInteger(estimated)?estimated:null;
  const fullyObserved=outsideFraction===0&&!approximate&&lowerFraction>=1-1e-12;
  return {available:true,status:upperFraction===0?'unobserved':fullyObserved?'observed':'partial',date,knownFraction,lowerFraction,upperFraction,outsideFraction,approximate,knownPixelsEstimate:estimated,exactKnownPixels,totalPixels,insidePixels};
}

// Only suggest a clearly better post-event capture that the current imagery mode
// can actually display. This function never changes the caller's selected date.
export function suggestObservationDate(prepared,bounds,currentDate,{notBefore='2017-08-25',minGain=.1,minCoverage=.2,allowedDates}={}){
  if(!states.has(prepared)||!validDate(notBefore)||!Number.isFinite(minGain)||minGain<0||minGain>1||!Number.isFinite(minCoverage)||minCoverage<0||minCoverage>1||(allowedDates!==undefined&&!Array.isArray(allowedDates)))return null;
  const currentCoverage=observationCoverage(prepared,bounds,currentDate);if(!currentCoverage.available)return null;
  const allowed=allowedDates===undefined?null:new Set(allowedDates);let best=null;
  for(const date of prepared.dates){
    if(date===currentDate||date<notBefore||(allowed&&!allowed.has(date)))continue;
    const coverage=observationCoverage(prepared,bounds,date);
    if(!coverage.available||coverage.lowerFraction<minCoverage||coverage.lowerFraction<=currentCoverage.upperFraction+minGain+1e-12)continue;
    if(!best||coverage.lowerFraction>best.coverage.lowerFraction||(coverage.lowerFraction===best.coverage.lowerFraction&&coverage.knownFraction>best.coverage.knownFraction))best={date,coverage,currentCoverage};
  }
  return best;
}
