// Independent read-only mayor demo. Never changes the family exercise.
const root = document.querySelector('#houston-content');
const status = document.querySelector('#houston-status');
const scenario = document.querySelector('#houston-scenario');
const NS = 'http://www.w3.org/2000/svg';
const categories = ['medical', 'evacuation', 'supplies', 'other'];
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = String(text); return n; };
const svgNode = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v)); return n; };
const number = n => Math.max(0, Number(n) || 0);
const count = n => number(n).toLocaleString('en-US');
const title = s => String(s || 'unknown').replaceAll('_', ' ').replace(/^./, c => c.toUpperCase());
const button = (text, action, cls = 'houston-button') => { const b = node('button', cls, text); b.type = 'button'; b.addEventListener('click', action); return b; };
const geometry = g => g?.type === 'Feature' ? g.geometry : g;
let sequence = 0;
async function load() {
  const generation = ++sequence;
  status.hidden = false; status.textContent = 'Loading Houston geography and simulated requests…'; root.hidden = true;
  try {
    const response = await fetch(`/api/houston?scenario=${encodeURIComponent(scenario.value)}`);
    if (!response.ok) throw new Error(`Houston data unavailable (${response.status}).`);
    const data = await response.json();
    if (data.available === false) throw new Error(data.reason || 'Verified Houston geography is unavailable.');
    if (generation !== sequence) return;
    if (data.city?.id !== 'houston' || !geometry(data.city.boundary)?.coordinates || !Array.isArray(data.regions) || !Array.isArray(data.city.bbox)) throw new Error('Houston geography is incomplete. No map is shown.');
    render(data); status.hidden = true; root.hidden = false;
  } catch (error) {
    if (generation !== sequence) return;
    status.replaceChildren(node('strong', '', 'Houston dashboard unavailable. '), node('span', '', error.message), button('Try again', load));
  }
}
function render(data) {
  root.replaceChildren();
  const regions = data.regions;
  const max = Math.max(0, ...regions.map(r => number(r.openCount)));
  const stats = node('div', 'houston-stats');
  const noReports = regions.filter(r => !number(r.openCount));
  for (const [value, label, detail] of [
    [data.stats?.openRequests ?? regions.reduce((s,r) => s + number(r.openCount),0), 'Simulated open requests', `${count(data.unlocatedRequests?.length || 0)} awaiting location review`],
    [regions.length - noReports.length, 'Areas with reports', 'Count is not severity'],
    [noReports.length, 'Coverage checks', 'No reports ≠ safe'],
    [data.urgentRequests?.length || 0, 'Urgent individual cases', 'Visible even in low-count areas']
  ]) { const item = node('article', 'houston-stat'); item.append(node('span', '', label), node('strong', '', count(value)), node('small', '', detail)); stats.append(item); }
  root.append(stats);
  const grid = node('div', 'houston-grid');
  const mapPanel = node('article', 'houston-map-panel');
  const heading = node('div','houston-panel-heading');
  const headingText = node('div'); headingText.append(node('div','eyebrow','CITY-LIMITED VIEW'),node('h2','','Houston request map'));
  heading.append(headingText, node('span','houston-chip','Open requests')); mapPanel.append(heading);
  mapPanel.append(node('p','houston-description',data.geography?.regionDescription || 'Houston subdivisions clipped to the city boundary. Neighboring cities are excluded.'));
  const mapRow = node('div','houston-map-row');
  const frame = node('div','houston-map-frame');
  const svg = svgNode('svg', {viewBox:'0 0 800 630',role:'group','aria-label':'Houston map. Focus or select an area to inspect open requests.'});
  const [west,south,east,north] = data.city.bbox;
  const cos = Math.cos((north + south) / 2 * Math.PI / 180);
  const scale = Math.min(730 / ((east-west)*cos), 570 / (north-south));
  const width = (east-west)*cos*scale; const height=(north-south)*scale;
  const project = ([lon,lat]) => [(800-width)/2+(lon-west)*cos*scale,(630-height)/2+(north-lat)*scale];
  function path(g) {
    const geom=geometry(g); const polys=geom?.type==='Polygon'?[geom.coordinates]:geom?.type==='MultiPolygon'?geom.coordinates:[];
    return polys.flatMap(poly=>poly.map(ring=>ring.map((p,i)=>`${i?'L':'M'}${project(p).map(v=>v.toFixed(3)).join(',')}`).join('')+'Z')).join('');
  }
  const cityPath = path(data.city.boundary);
  const defs=svgNode('defs');
  const clip=svgNode('clipPath',{id:'houston-city-clip',clipPathUnits:'userSpaceOnUse'}); clip.append(svgNode('path',{d:cityPath,'clip-rule':'evenodd','fill-rule':'evenodd'})); defs.append(clip);
  const pattern=svgNode('pattern',{id:'houston-unknown',width:8,height:8,patternUnits:'userSpaceOnUse'}); pattern.append(svgNode('path',{d:'M-2 2 L2 -2 M0 8 L8 0 M6 10 L10 6',stroke:'#85988d','stroke-width':.7,opacity:.55})); defs.append(pattern); svg.append(defs);
  const layer=svgNode('g',{'clip-path':'url(#houston-city-clip)'});
  layer.append(svgNode('path',{d:cityPath,fill:'#dce3d5','fill-rule':'evenodd'}));
  const imageryNote=node('p','houston-source');
  const basemap=data.basemap || {};
  if(basemap.available && typeof basemap.url==='string' && /^\/(?!\/)/.test(basemap.url) && Array.isArray(basemap.bbox)) {
    const [bw,bs,be,bn]=basemap.bbox; const [x,y]=project([bw,bn]);const [x2,y2]=project([be,bs]);
    const image=svgNode('image',{href:basemap.url,x,y,width:x2-x,height:y2-y,preserveAspectRatio:'none',opacity:.87});
    image.addEventListener('error',()=>{image.remove(); imageryNote.textContent='Aerial imagery unavailable. Geographic boundaries remain visible; report counts are unchanged.';}); layer.append(image);
    imageryNote.textContent=`Historical aerial imagery · ${basemap.date || 'date not provided'} · ${basemap.attribution || 'Attribution unavailable'}. Not live disaster imagery.`;
  } else imageryNote.textContent='Aerial imagery unavailable. Showing geographic boundaries only; no imagery is fabricated.';
  const detail=node('article','houston-detail'); detail.setAttribute('aria-label','Selected Houston area');
  const paths=new Map();let selected=null;let locked=false;
  function select(r,lock=false) {
    if(locked&&!lock) return;
    selected=r; if(lock) locked=true;
    for(const [id,p] of paths) {p.classList.toggle('is-selected',id===r.id);p.setAttribute('aria-pressed',String(id===r.id&&locked));}
    detail.replaceChildren(node('div','eyebrow',locked?'AREA DETAILS · PINNED':'AREA DETAILS · PREVIEW'),node('h3','',r.name));
    const total=node('div','houston-detail-total');total.append(node('strong','',count(r.openCount)),node('span','','open requests'));detail.append(total);
    detail.append(node('p','houston-intensity',max ? `${((number(r.openCount)/max)*100).toFixed(1)}% of maximum · ${count(r.openCount)} / ${count(max)}` : 'No open requests in this scenario'));
    const breakdown=node('dl','houston-breakdown');for(const c of categories)breakdown.append(node('dt','',title(c)),node('dd','',count(r.categories?.[c])));detail.append(breakdown);
    detail.append(node('p','houston-priority',number(r.openCount)?`Review priority: ${title(r.priority)}`:'Coverage status: unknown · check needed'));
    detail.append(node('p','houston-description','Red intensity shows volume only. Review priority is a separate human-review order. Need categories can overlap: 100 evacuation + 100 supplies may represent the same 100 distinct requests.'));
    detail.append(button(locked?'Unpin details':'Pin these details',()=>{locked=!locked;select(selected,locked);}));
  }
  for(const r of regions) {
    const p=svgNode('path',{d:path(r.geometry),fill:number(r.openCount)?'#e2292f':'url(#houston-unknown)','fill-opacity':number(r.openCount)?number(r.openCount)/max:1,'fill-rule':'evenodd',stroke:'#f5f6e8','stroke-width':1.1,'vector-effect':'non-scaling-stroke',tabindex:0,role:'button','aria-pressed':'false','aria-label':`${r.name}: ${count(r.openCount)} open requests, ${max?((number(r.openCount)/max)*100).toFixed(1):0}% of maximum; ${number(r.openCount)?'review priority '+title(r.priority):'unknown, coverage check needed'}`,class:'houston-region'});
    p.append(svgNode('title'));p.lastChild.textContent=`${r.name} · ${count(r.openCount)} open requests`;
    p.addEventListener('pointerenter',()=>select(r));p.addEventListener('focus',()=>select(r));p.addEventListener('click',()=>select(r,true));p.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();select(r,true);}if(e.key==='Escape'){locked=false;select(r);}});layer.append(p);paths.set(r.id,p);
  }
  for (const r of regions.filter(r => number(r.openCount) && Array.isArray(r.labelPoint))) {
    const [x,y] = project(r.labelPoint);
    const label = svgNode('text', {x,y,'text-anchor':'middle','dominant-baseline':'middle',class:'houston-map-count','pointer-events':'none'}); label.textContent=count(r.openCount);layer.append(label);
  }
  svg.append(layer,svgNode('path',{d:cityPath,fill:'none',stroke:'#244c45','stroke-width':1.8,'vector-effect':'non-scaling-stroke','pointer-events':'none'}));
  frame.append(svg,node('span','houston-north','N ↑'),node('span','houston-map-label','HOUSTON · TEXAS'));
  const legend=node('div','houston-scale');legend.setAttribute('aria-label',`Linear red intensity scale: 0 to ${max} open requests`);
  legend.append(node('strong','',count(max)));const bar=node('div','houston-colorbar');if(!max)bar.classList.add('is-empty');legend.append(bar,node('strong','','0'),node('span','','OPEN REQUESTS'));
  mapRow.append(frame,legend);mapPanel.append(mapRow,node('p','houston-map-help','Hatched areas: no reports, safety unknown. Hover or focus to preview; click or Enter to pin. Escape unpins.'),imageryNote);
  const source=node('p','houston-source',data.geography?.attribution || 'Geographic source attribution unavailable.');
  for(const sourceEntry of data.geography?.sourceUrls || []) { const url=typeof sourceEntry==='string'?sourceEntry:sourceEntry.url;if(typeof url==='string'&&/^https:\/\//.test(url)){const a=node('a','', ' Source ↗');a.href=url;a.target='_blank';a.rel='noopener noreferrer';source.append(a);} }
  mapPanel.append(source);
  const aside=node('aside','houston-map-aside');aside.append(detail,node('p','houston-warning','No reports does not mean safe. People without phones or hotline access may be missing from this picture.'));
  grid.append(mapPanel,aside);root.append(grid);
  if(regions.length)select([...regions].sort((a,b)=>number(b.openCount)-number(a.openCount))[0]);
  const lanes=node('div','houston-lanes');
  function lane(eyebrow,titleText,description){const l=node('article','houston-lane');l.append(node('div','eyebrow',eyebrow),node('h2','',titleText),node('p','houston-description',description));lanes.append(l);return l;}
  const review=lane('HUMAN REVIEW ORDER','Reported needs','Medical → evacuation → supplies → other. Demo review order only, not automated medical triage or dispatch.');
  const list=node('ol','houston-queue');
  const rank=r=>{const c=categories.findIndex(c=>number(r.categories?.[c])>0);return c<0?4:c;};
  const sorted=regions.filter(r=>number(r.openCount)).sort((a,b)=>rank(a)-rank(b)||number(b.openCount)-number(a.openCount));
  for(const [i,r] of sorted.entries()) {const li=node('li');const b=button('',()=>{select(r,true);detail.scrollIntoView({block:'nearest',behavior:'smooth'});},'houston-queue-row');const info=node('span');info.append(node('strong','',r.name),node('small','',`${title(r.priority)} · ${categories.filter(c=>number(r.categories?.[c])).map(c=>`${title(c)} ${count(r.categories[c])}`).join(' · ')}`));b.append(node('span','houston-rank',String(i+1).padStart(2,'0')),info,node('strong','houston-queue-count',count(r.openCount)));li.append(b);list.append(li);}
  review.append(sorted.length?list:node('p','houston-empty','No open reports in this simulation. Keep the coverage-check lane active.'));
  const coverage=lane('SEPARATE COVERAGE LANE',`${noReports.length} areas need a check`,'Zero reports means unknown. Review these areas for outreach gaps, including people unable to reach a phone or hotline.');
  const checks=node('div','houston-checks');for(const r of noReports){const b=button('',()=>{select(r,true);detail.scrollIntoView({block:'nearest',behavior:'smooth'});},'houston-coverage-row');b.append(node('span','',r.name),node('span','houston-unknown-chip','Unknown · 0'));checks.append(b);}coverage.append(noReports.length?checks:node('p','houston-empty','Every area has reports. Coverage remains incomplete; reports never establish safety.'));root.append(lanes);
  const urgent=node('section','houston-urgent');urgent.append(node('div','eyebrow','INDIVIDUAL NEEDS STAY VISIBLE'),node('h2','','Urgent cases, even in quiet areas'),node('p','houston-description','Low neighborhood volume must not hide an urgent individual request. These fictional reports require human review.'));
  const cards=node('div','houston-urgent-cards');for(const req of data.urgentRequests || []){const r=regions.find(r=>r.id===req.regionId);const card=node('article','houston-urgent-card');card.append(node('span','houston-chip',Array.isArray(req.categories)?req.categories.map(title).join(' / '):'Urgent review'),node('h3','',req.id),node('p','',req.summary || 'Details require human review.'),node('small','',`${r?.name || 'Location unconfirmed'} · ${r?count(r.openCount)+' area requests':'not placed on map'}`));if(r)card.append(button('View area ↗',()=>{select(r,true);detail.scrollIntoView({block:'nearest',behavior:'smooth'});}));cards.append(card);}urgent.append(cards.children.length?cards:node('p','houston-empty','No urgent individual reports in this scenario. This does not establish safety.'));root.append(urgent);
  if(data.unlocatedRequests?.length){const unlocated=node('section','houston-unlocated');unlocated.append(node('h3','',`${data.unlocatedRequests.length} ${data.unlocatedRequests.length === 1 ? 'request needs' : 'requests need'} location review`),node('p','','These requests are excluded from map counts, not from human review.'));for(const r of data.unlocatedRequests)unlocated.append(node('p','',`${r.id}: ${r.summary || 'Location not established'}`));root.append(unlocated);}
  root.append(node('p','houston-footer','SIMULATION ONLY · Real geography; fictional requests, separate from the family exercise below. No live emergency data, alerts, medical triage, or dispatch.'));
}
scenario.addEventListener('change',load);
load();
