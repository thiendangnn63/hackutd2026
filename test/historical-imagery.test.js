import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {historicalImagery,historicalImageFile} from '../src/historical-imagery.js';
const bbox=[-95.94,29.48,-94.99,30.14];
function fixture(t){
 const root=mkdtempSync(join(tmpdir(),'beacon-history-')),data=join(root,'public/data');
 mkdirSync(join(data,'water'),{recursive:true});mkdirSync(join(data,'flood-imagery'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const put=(name,value)=>writeFileSync(join(data,name),JSON.stringify(value));return {root,data,put};
}
test('absent historical products stay unavailable without fabricating flood coverage',t=>{
 const {root}=fixture(t);assert.deepEqual(historicalImagery(root),{water:{available:false,scenes:[]},flood:{available:false,imagery:[]},radar:{available:false}});
 assert.throws(()=>historicalImageFile(root,'/data/water/unlisted.png'),error=>error.status===404);
});
test('dated water bands and true-color products retain source dates, unknown coverage and exact registered files',t=>{
 const f=fixture(t),url='/data/water/harvey-mndwi-2017-08-30.png',rgbUrl='/data/water/harvey-rgb-2017-08-30.webp';
 writeFileSync(join(f.data,'water/harvey-mndwi-2017-08-30.png'),'fixture not decoded');writeFileSync(join(f.data,'water/harvey-rgb-2017-08-30.webp'),'fixture');
 f.put('houston-water-imagery.json',{schemaVersion:1,scenes:[{id:'scene',date:'2017-08-30',crs:'EPSG:4326',bbox,waterUrl:url,rgbUrl,validFraction:.64,bands:['B03','B11'],nativeResolutionMeters:20}]});
 const scene=historicalImagery(f.root).water.scenes[0];assert.equal(scene.url,url);assert.equal(scene.rgbUrl,rgbUrl);assert.equal(scene.date,'2017-08-30');assert.equal(scene.validFraction,.64);assert.deepEqual(scene.bands,['B03','B11']);
 assert.equal(historicalImageFile(f.root,url).contentType,'image/png');assert.equal(historicalImageFile(f.root,rgbUrl).contentType,'image/webp');
});
test('historical route registry rejects arbitrary paths, missing files, foreign URLs and symlinks',t=>{
 const f=fixture(t),outside=join(f.root,'private.png');writeFileSync(outside,'private fixture');symlinkSync(outside,join(f.data,'water/linked.png'));
 for(const waterUrl of ['/data/water/../../private.png','https://foreign.invalid/map.png','/data/water/linked.png','/data/water/missing.png']){
  f.put('houston-water-imagery.json',{schemaVersion:1,scenes:[{date:'2017-08-30',crs:'EPSG:4326',bbox,waterUrl}]});assert.equal(historicalImagery(f.root).water.available,false);assert.throws(()=>historicalImageFile(f.root,waterUrl),error=>error.status===404);
 }
});
test('NOAA flight strips remain per-date and missing detail does not invent complete coverage',t=>{
 const f=fixture(t),path='/data/flood-imagery/harvey-20170830-overview.webp';writeFileSync(join(f.data,'flood-imagery/harvey-20170830-overview.webp'),'fixture');
 f.put('houston-flood-imagery.json',{schemaVersion:1,crs:'EPSG:4326',imagery:[{id:'flight',date:'2017-08-30',overview:{path,bbox,coverageFraction:.12},detail:[{path:'/data/flood-imagery/missing.webp',bbox}]}]});
 const flight=historicalImagery(f.root).flood.imagery[0];assert.equal(flight.overview.url,path);assert.equal(flight.overview.coverageFraction,.12);assert.equal(flight.detail.length,0);assert.equal(flight.date,'2017-08-30');
});

test('missing same-date RGB remains explicitly unavailable while the valid water product survives',t=>{
 const f=fixture(t),waterUrl='/data/water/harvey-mndwi-2017-08-30.png';writeFileSync(join(f.data,'water/harvey-mndwi-2017-08-30.png'),'fixture');
 f.put('houston-water-imagery.json',{schemaVersion:1,scenes:[{date:'2017-08-30',crs:'EPSG:4326',bbox,waterUrl,rgbUrl:'/data/water/missing-rgb.webp'}]});
 const scene=historicalImagery(f.root).water.scenes[0];assert.equal(scene.waterUrl,waterUrl);assert.equal(scene.rgbUrl,null);assert.deepEqual(scene.availableModes,{water:true,rgb:false});
});
