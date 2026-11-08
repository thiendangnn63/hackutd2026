import test from 'node:test';
import assert from 'node:assert/strict';
import {selectImageryTiles} from '../public/imagery-model.js';
const tile=(level,row,column,bbox,available=true)=>({id:`naip-l${level}-r${String(row).padStart(2,'0')}-c${String(column).padStart(2,'0')}`,bbox,available,url:available?`/data/imagery/naip-l${level}-r${String(row).padStart(2,'0')}-c${String(column).padStart(2,'0')}.webp`:null});
function pyramid(){return {downloading:false,tiers:[
 {id:'coarse',metersPerPixel:20,tiles:[tile(0,0,0,[-96,29,-95,30])]},
 {id:'medium',metersPerPixel:10,tiles:[tile(1,0,0,[-96,29,-95.5,29.5]),tile(1,0,1,[-95.5,29,-95,29.5]),tile(1,1,0,[-96,29.5,-95.5,30]),tile(1,1,1,[-95.5,29.5,-95,30])]},
 {id:'fine',metersPerPixel:2.7,tiles:[tile(3,0,0,[-95.5,29.5,-95.25,29.75])]}
]};}
test('imagery detail increases with the geographic pixels per screen pixel and remains native at extreme zoom',()=>{
 const p=pyramid();
 const wide=selectImageryTiles(p,[-96,29,-95,30],{width:1000,height:1000,margin:0});assert.equal(wide.level,'coarse');assert.match(wide.resolutionLabel,/20 m\/px/);
 const close=selectImageryTiles(p,[-95.49,29.51,-95.45,29.55],{width:1440,height:960,margin:0});assert.equal(close.level,'fine');assert.equal(close.metersPerPixel,2.7);assert.equal(close.tiles.length,1);
 assert.equal(selectImageryTiles(p,[-95.49,29.51,-95.4899,29.5101],{width:1440,height:960,margin:0}).metersPerPixel,2.7);
});
test('retina requests finer real tiles, bounded to two device pixels without invented resolution',()=>{
 const p=pyramid(),bbox=[-95.49,29.51,-95.39,29.61];
 const standard=selectImageryTiles(p,bbox,{width:1000,height:1000,pixelRatio:1,margin:0});
 const retina=selectImageryTiles(p,bbox,{width:1000,height:1000,pixelRatio:2,margin:0});
 assert.equal(standard.level,'medium');assert.equal(retina.level,'fine');assert.equal(retina.targetMetersPerPixel,standard.targetMetersPerPixel/2);
 assert.equal(selectImageryTiles(p,bbox,{width:1000,height:1000,pixelRatio:10,margin:0}).targetMetersPerPixel,retina.targetMetersPerPixel);
});
test('missing files stay unavailable, use a coarser local tier and request refresh only during preparation',()=>{
 const p=pyramid();p.downloading=true;p.tiers[2].tiles[0].available=false;p.tiers[2].tiles[0].url=null;
 const selected=selectImageryTiles(p,[-95.49,29.51,-95.45,29.55],{width:1000,height:1000,margin:0});assert.equal(selected.requestedLevel,'fine');assert.equal(selected.level,'medium');assert.equal(selected.needsRefresh,true);
 p.downloading=false;assert.equal(selectImageryTiles(p,[-95.49,29.51,-95.45,29.55],{width:1000,height:1000}).needsRefresh,false);
 p.tiers.forEach(t=>t.tiles.forEach(image=>image.available=false));assert.deepEqual(selectImageryTiles(p,[-95.49,29.51,-95.45,29.55],{width:1000,height:1000}).tiles,[]);
});
test('tile selection is viewport-local with one-tile prefetch, center priority and a total cap',()=>{
 const tiles=[];for(let r=0;r<8;r++)for(let c=0;c<8;c++)tiles.push(tile(3,r,c,[c,r,c+1,r+1]));
 const p={tiers:[{id:'fine',metersPerPixel:2.7,tiles}]};
 const exact=selectImageryTiles(p,[3.2,3.2,3.8,3.8],{width:1000,height:1000,margin:0});assert.equal(exact.tiles.length,1);assert.equal(exact.tiles[0].id,'naip-l3-r03-c03');
 const prefetched=selectImageryTiles(p,[3.2,3.2,3.8,3.8],{width:1000,height:1000,margin:1,maxTiles:5});assert.equal(prefetched.tiles.length,5);assert.equal(prefetched.tiles[0].id,'naip-l3-r03-c03');
 assert.ok(prefetched.tiles.every(t=>t.bbox[0]>=2&&t.bbox[2]<=5&&t.bbox[1]>=2&&t.bbox[3]<=5));
 assert.equal(selectImageryTiles(p,[20,20,21,21],{width:1000,height:1000}).tiles.length,0);
});
test('selection neither mutates the manifest nor accepts arbitrary image URLs or malformed dimensions',()=>{
 const p=pyramid(),before=structuredClone(p);selectImageryTiles(p,[-95.49,29.51,-95.45,29.55],{width:1000,height:1000});assert.deepEqual(p,before);
 p.tiers.forEach(t=>t.tiles.forEach(image=>image.url='https://unrelated.invalid/image.webp'));assert.equal(selectImageryTiles(p,[-95.49,29.51,-95.45,29.55],{width:1000,height:1000}).tiles.length,0);
 for(const [bbox,viewport]of [[null,{width:1000,height:1000}],[[-96,29,-96,30],{width:1000,height:1000}],[[-96,29,-95,30],{width:0,height:1000}],[[-96,29,-95,30],{width:Infinity,height:1000}]])assert.deepEqual(selectImageryTiles(p,bbox,viewport).tiles,[]);
});


test('a ready prefetch neighbor cannot advertise a fine tier with no imagery in the actual viewport',()=>{
 const p=pyramid(),selection=selectImageryTiles(p,[-95.24,29.51,-95.21,29.54],{width:1000,height:1000,margin:1});
 assert.equal(selection.requestedLevel,'fine');assert.equal(selection.level,'medium');assert.equal(selection.metersPerPixel,10);
});


test('limited fallback budget prefers the nearest coarser detail and still returns coarse-to-fine paint order',()=>{
 const selected=selectImageryTiles(pyramid(),[-95.49,29.51,-95.45,29.55],{width:1440,height:960,maxTiles:3,margin:1});
 assert.equal(selected.level,'fine');assert.equal(selected.tiles.length,1);assert.equal(selected.fallbackTiles.length,2);
 assert.ok(selected.fallbackTiles.every(t=>t.id.startsWith('naip-l1-')));
});
