// Paired optical change only. Unknown comparisons never become zero change,
// damage severity, assistance demand or a statement of personal safety.
import {prepareObservationCoverage,observationCoverage} from './map-coverage.js';
const states=new WeakMap();
const fields=['column','row','pixelCount','pairedPixels','positivePixels','sumDeltaUnits','sumPositiveDeltaUnits','waterLikeIncreasePixels','sumWaterLikePositiveDeltaUnits'];
const extent=value=>Array.isArray(value)&&value.length===4&&value.every(Number.isFinite)&&value[0]>=-180&&value[2]<=180&&value[1]>=-90&&value[3]<=90&&value[0]<value[2]&&value[1]<value[3];
const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const sums=['pairedPixels','positivePixels','sumDeltaUnits','sumPositiveDeltaUnits','waterLikeIncreasePixels','sumWaterLikePositiveDeltaUnits'];
export function impactCellBounds(grid,column,row){
  if(!grid||!extent(grid.bbox)||![column,row,grid.width,grid.height,grid.cellSize].every(Number.isInteger)||column<0||row<0||grid.width<=0||grid.height<=0||grid.cellSize<=0||column*grid.cellSize>=grid.width||row*grid.cellSize>=grid.height)return null;
  const [west,south,east,north]=grid.bbox;
  return [west+(east-west)*column*grid.cellSize/grid.width,north-(north-south)*Math.min((row+1)*grid.cellSize,grid.height)/grid.height,
    west+(east-west)*Math.min((column+1)*grid.cellSize,grid.width)/grid.width,north-(north-south)*row*grid.cellSize/grid.height];
}
export function prepareImpact(raw){
  if(raw?.schemaVersion!==1||raw.metric!=='mean_positive_mndwi_delta'||!Array.isArray(raw.cellFields)||fields.some((field,index)=>raw.cellFields[index]!==field)||raw.cellFields.length!==fields.length)return null;
  const grid=raw.grid;
  if(!grid||grid.crs!=='EPSG:4326'||!extent(grid.bbox)||!['width','height','cellSize','columns','rows'].every(key=>Number.isInteger(grid[key]))||grid.width<1||grid.height<1||grid.width>10000||grid.height>10000||grid.cellSize<1||grid.cellSize>256||grid.columns!==Math.ceil(grid.width/grid.cellSize)||grid.rows!==Math.ceil(grid.height/grid.cellSize)||grid.columns*grid.rows>100000||!Number.isFinite(grid.nativeResolutionMeters)||grid.nativeResolutionMeters<=0||!Array.isArray(raw.comparisons)||!raw.comparisons.length||raw.comparisons.length>12)return null;
  const comparisons=new Map(),scenes=[];
  for(const comparison of raw.comparisons){
    if(typeof comparison?.id!=='string'||!/^[-a-zA-Z0-9_]{1,100}$/.test(comparison.id)||comparisons.has(comparison.id)||!date(comparison.beforeDate)||!date(comparison.afterDate)||comparison.beforeDate>=comparison.afterDate||!Array.isArray(comparison.cells)||comparison.cells.length>grid.columns*grid.rows)return null;
    const cells=new Array(grid.columns*grid.rows),counts=new Array(cells.length).fill(0),totals=Object.fromEntries(sums.map(key=>[key,0]));
    for(const values of comparison.cells){
      if(!Array.isArray(values)||values.length!==fields.length||!values.every(Number.isSafeInteger))return null;
      const cell=Object.fromEntries(fields.map((key,index)=>[key,values[index]])),{column,row,pixelCount,pairedPixels,positivePixels,sumDeltaUnits,sumPositiveDeltaUnits,waterLikeIncreasePixels,sumWaterLikePositiveDeltaUnits}=cell;
      if(column<0||column>=grid.columns||row<0||row>=grid.rows||cells[row*grid.columns+column]||pixelCount!==Math.min(grid.cellSize,grid.width-column*grid.cellSize)*Math.min(grid.cellSize,grid.height-row*grid.cellSize)||pairedPixels<1||pairedPixels>pixelCount||positivePixels<0||positivePixels>pairedPixels||sumPositiveDeltaUnits<positivePixels||sumPositiveDeltaUnits>positivePixels*20000||sumDeltaUnits>sumPositiveDeltaUnits||sumDeltaUnits<sumPositiveDeltaUnits-(pairedPixels-positivePixels)*20000||waterLikeIncreasePixels<0||waterLikeIncreasePixels>positivePixels||sumWaterLikePositiveDeltaUnits<0||sumWaterLikePositiveDeltaUnits>sumPositiveDeltaUnits)return null;
      cells[row*grid.columns+column]=cell;counts[row*grid.columns+column]=pairedPixels;
      for(const key of sums)totals[key]+=cell[key];
    }
    if(comparison.totals?.pixelCount!==grid.width*grid.height||comparison.totals.nonemptyCells!==comparison.cells.length||sums.some(key=>comparison.totals[key]!==totals[key]))return null;
    const summary=Object.freeze({id:comparison.id,beforeDate:comparison.beforeDate,afterDate:comparison.afterDate,
      pairedFraction:totals.pairedPixels/(grid.width*grid.height),meanPositiveDelta:totals.pairedPixels?totals.sumPositiveDeltaUnits/totals.pairedPixels/10000:null});
    comparisons.set(comparison.id,{summary,cells});
    scenes.push({date:comparison.afterDate,bbox:[...grid.bbox],width:grid.width,height:grid.height,columns:grid.columns,rows:grid.rows,counts,knownPixels:totals.pairedPixels});
  }
  const coverage=prepareObservationCoverage({schemaVersion:1,crs:'EPSG:4326',encoding:'observed-pixel-counts',blockSize:grid.cellSize,scenes});
  if(!coverage)return null;
  const handle=Object.freeze({metric:raw.metric,grid:Object.freeze({...grid,bbox:Object.freeze([...grid.bbox])}),comparisons:Object.freeze([...comparisons.values()].map(value=>value.summary))});
  states.set(handle,{comparisons,coverage});return handle;
}
export function impactCells(prepared,id){
  const comparison=states.get(prepared)?.comparisons.get(id);if(!comparison)return [];
  const {grid}=prepared,result=[];
  for(let row=0;row<grid.rows;row++)for(let column=0;column<grid.columns;column++){
    const cell=comparison.cells[row*grid.columns+column],pixelCount=Math.min(grid.cellSize,grid.width-column*grid.cellSize)*Math.min(grid.cellSize,grid.height-row*grid.cellSize),pairedPixels=cell?.pairedPixels||0;
    const score=pairedPixels?cell.sumPositiveDeltaUnits/pairedPixels/100:null;
    result.push({column,row,bounds:impactCellBounds(grid,column,row),pixelCount,pairedPixels,coverage:pairedPixels/pixelCount,score,
      displayScore:score===null?null:Math.min(100,score)});
  }
  return result;
}
export function impactCoverage(prepared,id,bounds){
  const state=states.get(prepared),comparison=state?.comparisons.get(id);
  return observationCoverage(state?.coverage,bounds,comparison?.summary.afterDate);
}
export function strongestImpactExample(prepared,id){
  if(!states.has(prepared))return null;
  const best=impactCells(prepared,id).filter(cell=>cell.coverage>=.5&&cell.score>0)
    .sort((a,b)=>b.score*b.coverage-a.score*a.coverage||a.row-b.row||a.column-b.column)[0];
  if(!best)return null;
  const [west,south,east,north]=prepared.grid.bbox,dx=best.bounds[2]-best.bounds[0],dy=best.bounds[3]-best.bounds[1];
  return {column:best.column,row:best.row,score:best.score,coverage:best.coverage,
    bounds:[Math.max(west,best.bounds[0]-dx),Math.max(south,best.bounds[1]-dy),Math.min(east,best.bounds[2]+dx),Math.min(north,best.bounds[3]+dy)]};
}
