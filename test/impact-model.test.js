import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {prepareImpact,impactCells,impactCellBounds,impactCoverage,strongestImpactExample} from '../public/impact-model.js';
const fields=['column','row','pixelCount','pairedPixels','positivePixels','sumDeltaUnits','sumPositiveDeltaUnits','waterLikeIncreasePixels','sumWaterLikePositiveDeltaUnits'];
function fixture(){
  const cells=[[0,0,4,4,0,-20000,0,0,0],[1,0,2,1,1,15000,15000,1,15000],[0,1,2,1,1,5000,5000,1,5000]];
  const totals={pixelCount:9,nonemptyCells:3};for(const [index,key]of fields.entries())if(index>=3)totals[key]=cells.reduce((sum,cell)=>sum+cell[index],0);
  return {schemaVersion:1,metric:'mean_positive_mndwi_delta',grid:{bbox:[0,0,3,3],crs:'EPSG:4326',width:3,height:3,cellSize:2,columns:2,rows:2,nativeResolutionMeters:20},cellFields:[...fields],
    comparisons:[{id:'change-a',beforeDate:'2017-08-15',afterDate:'2017-08-30',cells,totals}]};
}
test('positive paired change retains observed zero and unknown as different states with a fixed100+ scale',()=>{
  const model=prepareImpact(fixture()),cells=impactCells(model,'change-a');assert.ok(model);assert.equal(cells.length,4);
  assert.deepEqual(cells.map(cell=>cell.score),[0,150,50,null]);assert.deepEqual(cells.map(cell=>cell.displayScore),[0,100,50,null]);
  assert.deepEqual(cells.map(cell=>cell.coverage),[1,.5,.5,0]);
  assert.equal(impactCoverage(model,'change-a',[0,0,3,3]).knownFraction,6/9);
  assert.equal(impactCoverage(model,'change-a',[2,0,3,1]).status,'unobserved');
  assert.equal(impactCoverage(model,'change-a',[0,1,2,3]).status,'observed');
});
test('partial edge cell extents follow exact pixel dimensions instead of stretching all columns equally',()=>{
  const {grid}=fixture();assert.deepEqual(impactCellBounds(grid,1,0),[2,1,3,3]);assert.deepEqual(impactCellBounds(grid,1,1),[2,0,3,1]);
  assert.equal(impactCellBounds(grid,2,0),null);assert.equal(impactCellBounds(grid,-1,0),null);
});
test('coverage includes omitted cells and outside extent, with rigorous bounds for partial-cell views',()=>{
  const model=prepareImpact(fixture());
  const larger=impactCoverage(model,'change-a',[-3,0,3,3]);assert.equal(larger.knownFraction,1/3);assert.equal(larger.outsideFraction,.5);
  const outside=impactCoverage(model,'change-a',[4,4,5,5]);assert.equal(outside.status,'outside');assert.equal(outside.upperFraction,0);
  const partial=impactCoverage(model,'change-a',[2,2,3,3]);assert.equal(partial.approximate,true);assert.equal(partial.lowerFraction,0);assert.equal(partial.upperFraction,1);
  assert.equal(impactCoverage(model,'missing',[0,0,3,3]).available,false);
});
test('compilation is deterministic, does not mutate inputs and hides copied source arrays',()=>{
  const input=fixture(),before=structuredClone(input);const freeze=value=>{if(value&&typeof value==='object'){Object.freeze(value);for(const child of Object.values(value))freeze(child);}};freeze(input);
  const a=prepareImpact(input),b=prepareImpact(input);assert.deepEqual(a,b);assert.deepEqual(input,before);
  const cells=impactCells(a,'change-a');cells[0].bounds[0]=99;cells[0].score=99;
  assert.equal(impactCells(a,'change-a')[0].score,0);assert.equal(impactCells(a,'change-a')[0].bounds[0],0);
});
test('invalid schema, duplicate/negative/impossible cells and inconsistent totals remain unavailable',()=>{
  for(const mutate of [raw=>raw.metric='damage_severity',raw=>raw.grid.columns=3,raw=>raw.cellFields.reverse(),
    raw=>raw.comparisons[0].cells.push([...raw.comparisons[0].cells[0]]),raw=>raw.comparisons[0].cells[0][2]=3,
    raw=>raw.comparisons[0].cells[0][3]=-1,raw=>raw.comparisons[0].cells[1][6]=30000,
    raw=>raw.comparisons[0].totals.pairedPixels++,raw=>raw.comparisons[0].beforeDate='2017-09-01']){
    const raw=fixture();mutate(raw);assert.equal(prepareImpact(raw),null);
  }
});
test('bundled comparisons preserve totals above signed32bit and exact whole-extent joint coverage',()=>{
  const raw=JSON.parse(readFileSync(new URL('../public/data/houston-water-change.json',import.meta.url),'utf8')),model=prepareImpact(raw);assert.ok(model);
  assert.ok(raw.comparisons[1].totals.sumPositiveDeltaUnits>2147483647);
  for(const comparison of raw.comparisons){
    const summary=model.comparisons.find(item=>item.id===comparison.id),coverage=impactCoverage(model,comparison.id,raw.grid.bbox);
    assert.equal(coverage.exactKnownPixels,comparison.totals.pairedPixels);
    assert.equal(coverage.knownFraction,comparison.totals.pairedPixels/comparison.totals.pixelCount);
    assert.ok(Math.abs(summary.meanPositiveDelta-comparison.totals.sumPositiveDeltaUnits/comparison.totals.pairedPixels/10000)<1e-12);
    assert.equal(impactCells(model,comparison.id).length,72*58);
  }
});
test('explicit change example uses the strongest real positive sufficiently observed cell without inventing values',()=>{
  const raw=fixture(),prepared=prepareImpact(raw),example=strongestImpactExample(prepared,'change-a');
  assert.equal(example.column,1);assert.equal(example.row,0);assert.equal(example.score,150);assert.equal(example.coverage,.5);
  assert.deepEqual(example.bounds,[1,0,3,3]);assert.deepEqual(example,strongestImpactExample(prepared,'change-a'));assert.equal(strongestImpactExample(prepared,'missing'),null);
  const negative=fixture();negative.comparisons[0].cells=[[0,0,4,4,0,-20000,0,0,0]];
  negative.comparisons[0].totals={pixelCount:9,nonemptyCells:1,pairedPixels:4,positivePixels:0,sumDeltaUnits:-20000,sumPositiveDeltaUnits:0,waterLikeIncreasePixels:0,sumWaterLikePositiveDeltaUnits:0};
  assert.equal(strongestImpactExample(prepareImpact(negative),'change-a'),null);
});
