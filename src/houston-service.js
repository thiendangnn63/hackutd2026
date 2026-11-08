import { readFileSync, existsSync } from 'node:fs';
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
export class HoustonService {
  constructor(root) { this.root = root; }
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
        basemap: { ...image, available: hasImage, url: hasImage ? '/data/houston-imagery.jpg' : null, reason: hasImage ? null : (image.reason || 'Aerial imagery is unavailable. Boundaries and simulated counts remain visible.') },
        ...summary,
        limitations: ['Fictional open requests, separate from the Oak District family exercise. No live SMS data.', 'Red intensity reflects request volume, not severity, population risk or personal safety.', 'Review order medical, evacuation, supplies is a demo preference, not clinical triage or automatic dispatch.', 'No-report areas remain unknown and need coverage checks.', 'Historical background context may include surrounding cities; request tiles and selections remain Houston-only.'],
      };
    } catch {
      return { available: false, mode: 'simulation', reason: 'Verified Houston geography is not available. No approximate city shapes or report counts have been substituted.' };
    }
  }
}
