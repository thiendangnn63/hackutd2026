import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { resolve } from 'node:path';
import { InputError } from './domain.js';
import { buildHoustonSummary, createHoustonFixtures } from './houston.js';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const CONTEXT_FILES = new Set(['earth-context.jpg','houston-context.jpg','houston-metro.png']);
function contextBasemaps(metadata,directory) {
  return (Array.isArray(metadata.contextBasemaps)?metadata.contextBasemaps:[]).map(image=>{
    const bbox=image?.bbox;
    const valid=image&&CONTEXT_FILES.has(image.file)&&image.crs==='EPSG:4326'&&
      Array.isArray(bbox)&&bbox.length===4&&bbox.every(Number.isFinite)&&
      bbox[0]>=-180&&bbox[2]<=180&&bbox[1]>=-90&&bbox[3]<=90&&bbox[0]<bbox[2]&&bbox[1]<bbox[3];
    const available=Boolean(valid&&image.available===true&&existsSync(resolve(directory,image.file)));
    return {...image,available,url:available?`/data/${image.file}`:null,
      reason:available?null:'This historical context image is unavailable; other geographic layers remain visible.'};
  });
}
const TILE_NAME=/^naip-l[0-3]-r\d{2}-c\d{2}\.webp$/;
const validExtent=b=>Array.isArray(b)&&b.length===4&&b.every(Number.isFinite)&&b[0]>=-180&&b[2]<=180&&b[1]>=-90&&b[3]<=90&&b[0]<b[2]&&b[1]<b[3];
function pyramidView(directory){
  const unavailable=reason=>({schemaVersion:1,available:false,downloading:false,complete:false,crs:'EPSG:4326',tiers:[],reason,manifestUrl:'/api/houston/imagery'});
  try{
    const raw=readJson(resolve(directory,'houston-imagery-pyramid.json'));
    if(raw.schemaVersion!==1||raw.crs!=='EPSG:4326'||!validExtent(raw.bbox)||!Array.isArray(raw.tiers)||raw.tiers.length>8)return unavailable('Historical aerial detail manifest is unavailable. Geographic context remains visible.');
    const tiers=[];const ids=new Set();
    for(const tier of raw.tiers){
      if(!/^naip-(4|8|16|32)k$/.test(tier.id)||!Number.isInteger(tier.level)||tier.level<0||tier.level>3||
        !Number.isFinite(tier.metersPerPixel)||tier.metersPerPixel<=0||!Array.isArray(tier.tiles)||tier.tiles.length>1000)continue;
      const tiles=[];
      for(const tile of tier.tiles){
        if(!TILE_NAME.test(tile.file)||tile.file!==tile.id+'.webp'||!tile.file.startsWith(`naip-l${tier.level}-`)||ids.has(tile.id)||!validExtent(tile.bbox)||
          ![tile.width,tile.height].every(n=>Number.isInteger(n)&&n>=256&&n<=4000)||
          !Number.isFinite(tile.metersPerPixel)||tile.metersPerPixel<=0||
          tile.bbox[0]<raw.bbox[0]-1e-9||tile.bbox[1]<raw.bbox[1]-1e-9||tile.bbox[2]>raw.bbox[2]+1e-9||tile.bbox[3]>raw.bbox[3]+1e-9)continue;
        ids.add(tile.id);const path=resolve(directory,'imagery',tile.file);
        const exists=existsSync(path)&&lstatSync(path).isFile();
        const available=tile.available===true&&exists;
        tiles.push({...tile,level:tier.level,available,url:available?`/data/imagery/${tile.file}`:null,
          reason:available?null:tile.failureReason||'This detail tile is not available locally; coarser imagery remains underneath.'});
      }
      tiers.push({...tier,tiles,availableTiles:tiles.filter(t=>t.available).length,complete:tiles.length>0&&tiles.every(t=>t.available)});
    }
    const all=tiers.flatMap(t=>t.tiles),available=all.filter(t=>t.available);
    const planned=raw.tiers.reduce((sum,tier)=>sum+(Array.isArray(tier.tiles)?tier.tiles.length:0),0);
    const rejected=planned-all.length;
    return {...raw,tiers,available:available.length>0,downloading:raw.downloading===true,
      complete:planned>0&&available.length===planned&&tiers.length===raw.tiers.length,manifestUrl:'/api/houston/imagery',
      stats:{totalTiles:planned,validatedTiles:all.length,rejectedTiles:rejected,availableTiles:available.length,bytes:available.reduce((sum,t)=>sum+(Number.isFinite(t.bytes)?t.bytes:0),0),failedTiles:all.filter(t=>t.status==='failed').length}};
  }catch{return unavailable('Historical aerial detail is not prepared yet. Geographic context remains visible.');}
}
export class HoustonService {
  constructor(root) { this.root = root; }
  imageryPyramid(){return pyramidView(resolve(this.root,'public/data'));}
  imageryTile(filename){
    if(!TILE_NAME.test(filename))throw new InputError('Aerial detail tile not found.',404);
    const tile=this.imageryPyramid().tiers.flatMap(t=>t.tiles).find(t=>t.file===filename&&t.available);
    if(!tile)throw new InputError('Aerial detail tile not found.',404);
    return readFileSync(resolve(this.root,'public/data/imagery',tile.file));
  }
  view({ scenario = 'normal', city = 'houston' } = {}) {
    if (city !== 'houston') throw new InputError('This dashboard covers Houston only.');
    if (!['normal', 'empty'].includes(scenario)) throw new InputError('Choose the normal or empty simulated scenario.');
    const data = resolve(this.root, 'public/data');
    try {
      const boundary = readJson(resolve(data, 'houston-city.json'));
      const neighborhoods = readJson(resolve(data, 'houston-neighborhoods.json'));
      const metadata = readJson(resolve(data, 'houston-geography-meta.json'));
      if (boundary.type !== 'Feature' || !['Polygon', 'MultiPolygon'].includes(boundary.geometry?.type) || neighborhoods.type !== 'FeatureCollection' || !neighborhoods.features.length || !Array.isArray(metadata.bbox) || metadata.bbox.length !== 4 || !metadata.bbox.every(Number.isFinite)) throw new Error('Invalid Houston geometry');
      const regions = neighborhoods.features.map(feature => ({ id: typeof feature.properties?.id === 'string' ? feature.properties.id : '', name: feature.properties?.name, labelPoint: feature.properties?.labelPoint || null, geometry: feature.geometry }));
      if (regions.some(region => !region.id || typeof region.name !== 'string' || !['Polygon', 'MultiPolygon'].includes(region.geometry?.type)) || new Set(regions.map(region => region.id)).size !== regions.length) throw new Error('Invalid Houston regions');
      const summary = buildHoustonSummary(regions, createHoustonFixtures(regions, { mode: scenario }));
      const image = metadata.basemap || {};
      const hasImage = image.available === true && image.file === 'houston-imagery.jpg' && existsSync(resolve(data, image.file));
      return {
        available: true, mode: 'simulation', scenario,
        city: { id: 'houston', name: 'Houston', boundary, bbox: metadata.bbox },
        geography: { sourceUrls: metadata.sourceUrls || [], attribution: metadata.attribution || '', regionDescription: metadata.regionDescription || 'Official subdivisions clipped to Houston city limits.' },
        contextBasemaps: contextBasemaps(metadata,data),
        imageryPyramid: this.imageryPyramid(),
        basemap: { ...image, available: hasImage, url: hasImage ? '/data/houston-imagery.jpg' : null, reason: hasImage ? null : (image.reason || 'Aerial imagery is unavailable. Boundaries and simulated counts remain visible.') },
        ...summary,
        limitations: ['Fictional open requests, separate from the Oak District family exercise. No live SMS data.', 'Red intensity reflects request volume, not severity, population risk or personal safety.', 'Review order medical, evacuation, supplies is a demo preference, not clinical triage or automatic dispatch.', 'No-report areas remain unknown and need coverage checks.', 'Historical background context may include surrounding cities; request tiles and selections remain Houston-only.'],
      };
    } catch {
      return { available: false, mode: 'simulation', reason: 'Verified Houston geography is not available. No approximate city shapes or report counts have been substituted.' };
    }
  }
}
