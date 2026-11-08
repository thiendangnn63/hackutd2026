import {readFileSync,existsSync,lstatSync} from 'node:fs';
import {resolve} from 'node:path';
import {InputError} from './domain.js';

const extent=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]>=-180&&b[2]<=180&&b[1]>=-90&&b[3]<=90&&b[0]<b[2]&&b[1]<b[3];
const json=path=>{try{return JSON.parse(readFileSync(path,'utf8'));}catch{return null;}};
const date=value=>typeof value==='string'&&/^2017-\d{2}-\d{2}$/.test(value);
function registerAsset(root,url,bbox,registry){
  if(typeof url!=='string'||!/^\/data\/(water|flood-imagery)\/[a-z0-9][a-z0-9-]{0,110}\.(webp|png)$/.test(url)||!extent(bbox))return null;
  const path=resolve(root,'public',url.slice(1));
  if(!existsSync(path)||!lstatSync(path).isFile())return null;
  registry.set(url,{path,contentType:url.endsWith('.png')?'image/png':'image/webp'});return url;
}
function buildHistory(root){
  const registry=new Map(),directory=resolve(root,'public/data');
  const waterRaw=json(resolve(directory,'houston-water-imagery.json'));
  const floodRaw=json(resolve(directory,'houston-flood-imagery.json'));
  const water={available:false,scenes:[]},flood={available:false,imagery:[]};
  let radar={available:false};
  const radarRaw=json(resolve(directory,'houston-radar-imagery.json'));
  if(radarRaw?.schemaVersion===1&&radarRaw.crs==='EPSG:4326'&&date(radarRaw.date)&&extent(radarRaw.bbox)){
    const url=registerAsset(root,radarRaw.url,radarRaw.bbox,registry);if(url)radar={...radarRaw,url,available:true};
  }
  if(waterRaw?.schemaVersion===1&&Array.isArray(waterRaw.scenes)){
    Object.assign(water,waterRaw,{available:false,scenes:[]});
    for(const raw of waterRaw.scenes.slice(0,12)){
      if(!date(raw.date)||raw.crs!=='EPSG:4326'||!extent(raw.bbox))continue;
      const scene={...raw};
      for(const key of ['url','waterUrl','rgbUrl','indexUrl'])scene[key]=registerAsset(root,raw[key],raw.bbox,registry);
      scene.waterUrl=scene.waterUrl||scene.url;scene.url=scene.waterUrl;
      scene.availableModes={water:Boolean(scene.waterUrl),rgb:Boolean(scene.rgbUrl)};scene.available=Boolean(scene.waterUrl||scene.rgbUrl);if(scene.available)water.scenes.push(scene);
    }
    water.available=water.scenes.length>0;
  }
  if(floodRaw?.schemaVersion===1&&floodRaw.crs==='EPSG:4326'&&Array.isArray(floodRaw.imagery)){
    Object.assign(flood,floodRaw,{available:false,imagery:[]});
    const asset=raw=>{
      if(!raw||!extent(raw.bbox))return null;
      const url=registerAsset(root,raw.path||raw.url,raw.bbox,registry);return url?{...raw,url}:null;
    };
    for(const raw of floodRaw.imagery.slice(0,20)){
      if(!date(raw.date))continue;
      const overview=asset(raw.overview),detail=(raw.detail||[]).slice(0,30).map(asset).filter(Boolean);
      if(overview||detail.length)flood.imagery.push({...raw,overview,detail,available:true});
    }
    flood.available=flood.imagery.length>0;
  }
  return {view:{water,flood,radar},registry};
}
export function historicalImagery(root){return buildHistory(root).view;}
export function historicalImageFile(root,url){
  const file=buildHistory(root).registry.get(url);if(!file)throw new InputError('Historical image not found.',404);return file;
}
