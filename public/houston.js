import {node,button,svgNode,icon,iconButton,title,count} from './ui.js';
import {geometryOf,geometryBounds,demoLocations,buildSubtiles,detailLevel,cameraView,zoomAt,startGesture,moveGesture,hospitalityFixture,hospitalityForRegion,NEED_TYPES} from './map-model.js';
const $=s=>document.querySelector(s);
const root=$('#houston-content'),status=$('#houston-status'),frame=$('#map-view');
let data,svg,project,paths=new Map(),cells=new Map(),pois=[],mapSize={width:1000,height:700};
let camera={x:400,y:315,zoom:1},level=-1,layer='assistance',filter='all',queue='priority',selected=null,loadId=0;
let paintLayer,poiLayer,imagery,gesture=null,observer,renderFrame=0,animationFrame=0;
const pointers=new Map(),detail=$('#map-detail'),tooltip=$('#map-tooltip');
const mobile=()=>window.matchMedia('(max-width:760px)').matches;
const sidebarWidth=()=>mobile()||frame.classList.contains('overview-collapsed')?0:document.querySelector('#operations-panel').getBoundingClientRect().right-frame.getBoundingClientRect().left+20;
const parentHospitality=r=>cells.get(`${r.id}:0`)?.[0]?.hospitality||hospitalityFixture(`${r.id}/0/0/0`);
function revealDetail(){detail.hidden=false;if(mobile()){frame.classList.remove('panel-open');$('#mobile-panel-toggle').setAttribute('aria-expanded','false');}}
function updateBreadcrumb(){const trail=$('#map-breadcrumb');trail.replaceChildren();trail.hidden=!selected;if(!selected)return;trail.append(button('Houston',()=>fitHouston(true),'breadcrumb-button'),icon('chevron'));const name=button(selected.region.name,()=>selectArea(selected.region),'breadcrumb-button');trail.append(name);if(selected.cell){trail.append(icon('chevron'),node('span','breadcrumb-current',selected.cell.name.split(' · ').at(-1)));}}
function reconcileAreas(){if(!svg||!paintLayer)return;const v=cameraView(camera,mapSize.width,mapSize.height);for(const area of paintLayer.querySelectorAll('[data-region-id]')){const b=JSON.parse(area.dataset.bounds),visible=b.x<v.x+v.width&&b.x+b.width>v.x&&b.y<v.y+v.height&&b.y+b.height>v.y;const pressed=selected?.region.id===area.dataset.regionId&&(selected.cell?selected.cell.id===area.dataset.cellId:!area.dataset.cellId);area.setAttribute('tabindex',visible?'0':'-1');area.setAttribute('aria-pressed',String(pressed));area.classList.toggle('is-selected',pressed);}for(const [id,path]of paths)path.classList.toggle('is-selected',selected?.region.id===id&&!selected.cell);}
const metric=item=>filter==='all'?item.openCount:item.categories?.[filter]||0;
const alpha=()=>Number($('#tile-opacity').value)/100;
const polygons=value=>{const g=geometryOf(value);return g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'?g.coordinates:[];};
function path(g){return polygons(g).flatMap(p=>p.map(r=>r.map((v,i)=>`${i?'L':'M'}${project(v).map(n=>n.toFixed(3)).join(',')}`).join('')+'Z')).join('');}
function rectangle(bounds){const a=project([bounds[0],bounds[3]]),b=project([bounds[2],bounds[1]]);return {x:a[0],y:a[1],width:b[0]-a[0],height:b[1]-a[1]};}
function screenPoint(x,y){const p=svg.createSVGPoint();p.x=x;p.y=y;return p.matrixTransform(svg.getScreenCTM().inverse());}
function setCamera(next){
  camera=next;const v=cameraView(camera,mapSize.width,mapSize.height);
  svg.setAttribute('viewBox',`${v.x} ${v.y} ${v.width} ${v.height}`);
  $('#map-zoom-in').disabled=camera.zoom>=24;$('#map-zoom-out').disabled=camera.zoom<=.4;
  const nextLevel=detailLevel(camera.zoom);
  if(level!==nextLevel){level=nextLevel;renderTiles();}
  for(const marker of poiLayer.children)marker.setAttribute('transform',`translate(${marker.dataset.x} ${marker.dataset.y}) scale(${800/mapSize.width/camera.zoom})`);
  const unit=800/mapSize.width/camera.zoom;
  reconcileAreas();
  for(const text of svg.querySelectorAll('.map-place-name')){
    text.setAttribute('font-size',Number(text.dataset.size||10)*unit);
    text.style.strokeWidth=String(2.5*unit);text.style.letterSpacing=String(.45*unit)+'px';
  }
  svg.querySelector('#unknown-hatch').setAttribute('patternTransform',`scale(${unit})`);
  $('#map-resolution').textContent=['Neighborhood view','Subtiles · level 1','Subtiles · level 2'][level];
  $('#legend-resolution').textContent=['Areas','Subtiles','Subtiles'][level];
}
function stopAnimation(){if(animationFrame)cancelAnimationFrame(animationFrame);animationFrame=0;}
function animateCamera(target){stopAnimation();if(window.matchMedia('(prefers-reduced-motion:reduce)').matches){setCamera(target);return;}const start={...camera},at=performance.now();const tick=now=>{const t=Math.min(1,(now-at)/220),ease=1-(1-t)**3;setCamera({x:start.x+(target.x-start.x)*ease,y:start.y+(target.y-start.y)*ease,zoom:start.zoom+(target.zoom-start.zoom)*ease});if(t<1)animationFrame=requestAnimationFrame(tick);else animationFrame=0;};animationFrame=requestAnimationFrame(tick);}
function fitHouston(focus=false){
  stopAnimation();
  if(!svg)return;const sidebar=sidebarWidth();
  const zoom=Math.max(.4,Math.min((mapSize.width-sidebar-40)/mapSize.width,800*mapSize.height/mapSize.width/630)*.95);
  setCamera({zoom,x:400-sidebar/2*800/mapSize.width/zoom,y:315});closeDetail();if(focus)svg.focus({preventScroll:true});
}
function focusBounds(bounds,zoomFloor=0){
  stopAnimation();
  const r=rectangle(bounds),sidebar=sidebarWidth();
  const zoom=Math.min(24,Math.max(zoomFloor,Math.min((mapSize.width-sidebar-110)/mapSize.width*800/r.width,(mapSize.height-130)/mapSize.width*800/r.height)));
  setCamera({zoom:Math.max(.4,zoom),x:r.x+r.width/2-sidebar/2*800/mapSize.width/zoom,y:r.y+r.height/2});
}
function closeDetail(){detail.hidden=true;selected=null;reconcileAreas();updateBreadcrumb();}
function showTooltip(item,event){
  const value=layer==='assistance'?`${count(metric(item))} open requests`:(item.hospitality?.score==null?'Suitability unknown':`${item.hospitality.score}% planning suitability`);
  tooltip.replaceChildren(node('strong','',item.name),node('span','',value));tooltip.hidden=false;
  const b=frame.getBoundingClientRect(),target=event?.target?.getBoundingClientRect();
  const x=event?.clientX??target?.x??b.width/2,y=event?.clientY??target?.y??b.height/2;
  tooltip.style.left=`${Math.min(b.width-265,Math.max(12,x-b.x+14))}px`;tooltip.style.top=`${Math.min(b.height-90,Math.max(65,y-b.y-70))}px`;
}
function areaData(region,cell=null){return cell||{...region,hospitality:parentHospitality(region)};}
function selectArea(region,cell=null,zoom=true){
  selected={region,cell};tooltip.hidden=true;
  if(zoom)focusBounds(cell?.bounds||geometryBounds(region.geometry),cell?Math.max(5,camera.zoom*1.4):3);
  reconcileAreas();updateBreadcrumb();
  const item=areaData(region,cell);revealDetail();
  const header=node('div','detail-heading'),copy=node('div');copy.append(node('div','micro-label',cell?'HOUSTON / SUBTILE':'HOUSTON / NEIGHBORHOOD'),node('h2','',item.name));
  header.append(copy,iconButton('close','Close area details',()=>{closeDetail();svg.focus({preventScroll:true});}));detail.replaceChildren(header);
  if(layer==='assistance'){
    const total=node('div','detail-total',count(metric(item)));total.append(node('small','','open requests'));detail.append(total);
    const breakdown=node('dl','detail-breakdown');for(const c of NEED_TYPES){const dt=node('dt');dt.append(node('i'),document.createTextNode(title(c)));breakdown.append(dt,node('dd','',count(item.categories?.[c])));}detail.append(breakdown);
    detail.append(node('span',`pill ${item.openCount?'red':''}`,item.openCount?'Reported needs · fictional':'Unknown coverage · check needed'));
    detail.append(node('p','detail-source',cell?'Subtile locations are synthesized for this exercise. Counts roll up to the neighborhood total.':'Unique open requests. Categories may overlap. Volume does not establish severity or safety.'));
    if(!cell)for(const request of data.urgentRequests.filter(r=>r.regionId===region.id))detail.append(node('p','urgent-case-note',`Urgent individual review · ${request.summary}`));
  }else{
    const h=item.hospitality,total=node('div','detail-total',h.score==null?'—':`${h.score}%`);total.append(node('small','','planning suitability'));detail.append(total);
    const list=node('dl','detail-breakdown');for(const [name,key] of [['Power','power'],['Water','water'],['Access','access']])list.append(node('dt','',name),node('dd','',h[key]==null?(h.utilityCoverage?.[key]?.unknown===100?'Unknown':`${h.utilityCoverage?.[key]?.available??0}% available`):h[key]?'Available':'Unavailable'));list.append(node('dt','','Demo capacity'),node('dd','',h.capacity==null?'Unknown':`${count(h.capacity)} known places`));detail.append(list,node('span','pill blue',`Demo inputs · ${h.coverage??0}% coverage`),node('p','detail-source','Blue reflects area-weighted fictional utility and access inputs. Unknown parts are excluded from the score; known capacity is conserved as you zoom. A site inspection and agency approval are required before use as a shelter. Building imagery alone does not establish suitability.'));
  }
  const actions=node('div','detail-actions');if(cell)actions.append(button('Neighborhood',()=>selectArea(region),'control'));else actions.append(button('Explore subtiles',()=>focusBounds(geometryBounds(region.geometry),Math.max(5,camera.zoom*1.4)),'control'));
  actions.append(button('Back to Houston',()=>fitHouston(true),'control'));detail.append(actions);
  detail.focus({preventScroll:true});
}
function bindArea(el,region,cell=null){
  const item=areaData(region,cell);el.setAttribute('tabindex','0');el.setAttribute('role','button');el.setAttribute('aria-pressed','false');
  el.setAttribute('aria-label',`${item.name}: ${layer==='assistance'?count(metric(item))+' open requests':item.hospitality.score==null?'suitability unknown':item.hospitality.score+'% demo hospitality suitability'}. ${item.openCount?'Fictional reports.':'Coverage unknown.'}`);
  el.dataset.regionId=region.id;if(cell)el.dataset.cellId=cell.id;el.dataset.bounds=JSON.stringify(rectangle(cell?.bounds||geometryBounds(region.geometry)));
  el.addEventListener('pointerenter',e=>{if(!gesture?.moved)showTooltip(item,e);});el.addEventListener('pointerleave',()=>{tooltip.hidden=true;});el.addEventListener('focus',e=>showTooltip(item,e));el.addEventListener('blur',()=>{tooltip.hidden=true;});
  el.addEventListener('click',e=>{if(!e.detail)selectArea(region,cell);});el.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();selectArea(region,cell);}});
}
function renderTiles(){
  if(!paintLayer)return;const focused=document.activeElement?.closest('[data-region-id]')?.dataset;tooltip.hidden=true;paintLayer.replaceChildren();paths.clear();
  const all=data.regions.flatMap(r=>level?cells.get(`${r.id}:${level}`):[areaData(r)]),max=Math.max(0,...all.map(metric));
  const fill=item=>layer==='hospitality'?(item.hospitality.score==null?'url(#unknown-hatch)':'#437cc8'):(metric(item)?'#d6544e':'url(#unknown-hatch)');
  const opacity=item=>layer==='hospitality'?(item.hospitality.score==null ? .55*alpha() : item.hospitality.score/100*alpha()):(metric(item)?metric(item)/Math.max(1,max)*alpha():.55*alpha());
  for(const region of data.regions){
    const outline=svgNode('path',{d:path(region.geometry),fill:level?'transparent':fill(areaData(region)),'fill-opacity':level?0:opacity(areaData(region)),'fill-rule':'evenodd',stroke:'#f7f8ef','stroke-width':level ? .6 : .9,'vector-effect':'non-scaling-stroke',class:'map-region'});
    if(!level){bindArea(outline,region);paintLayer.append(outline);}else{
      const group=svgNode('g',{'clip-path':`url(#clip-${region.id})`});for(const cell of cells.get(`${region.id}:${level}`).filter(c=>c.hasArea)){const r=svgNode('rect',{...rectangle(cell.bounds),fill:fill(cell),'fill-opacity':opacity(cell),stroke:'#ffffff','stroke-width':.7,'vector-effect':'non-scaling-stroke',class:'map-subtile'});bindArea(r,region,cell);group.append(r);}outline.setAttribute('pointer-events','none');paintLayer.append(group,outline);
    }paths.set(region.id,outline);
  }
  reconcileAreas();if(focused){const replacement=[...paintLayer.querySelectorAll('[data-region-id]')].find(e=>e.dataset.regionId===focused.regionId&&e.dataset.cellId===focused.cellId);(replacement||svg).focus({preventScroll:true});}
  $('#legend-maximum').textContent=layer==='hospitality'?'100% suitability':`${count(max)} requests`;$('#legend-title').textContent=layer==='hospitality'?'Hospitality suitability':filter==='all'?'Open assistance requests':`${title(filter)} requests`;$('#legend-ramp').classList.toggle('blue',layer==='hospitality');$('#legend-unknown').textContent=layer==='hospitality'?'Hatched · suitability unknown':filter==='all'?'No reports · coverage unknown':`No ${filter} reports · coverage unknown`;
}
function renderMetrics(){
  const metrics=$('#map-metrics');metrics.replaceChildren();for(const [value,label,tone] of [[data.stats.openRequests,'Open requests',''],[data.stats.coverageChecks,'Coverage checks',''],[data.stats.urgentRequests,'Urgent cases','metric-alert']]){const e=node('div',tone);e.append(node('strong','',count(value)),node('small','',label));metrics.append(e);}$('#coverage-count').textContent=data.stats.coverageChecks;document.querySelector('.operations-heading p').textContent=`${data.regions.length} coverage areas · Houston city limits`;
}
function renderQueue(){
  if(!data)return;const term=$('#map-search').value.trim().toLocaleLowerCase();
  const rows=data.regions.filter(r=>queue==='coverage'?!r.openCount:layer==='hospitality'?parentHospitality(r).score!=null:r.openCount>0&&metric(r)>0).filter(r=>!term||r.name.toLocaleLowerCase().includes(term));
  if(term)for(const r of data.regions)if(r.name.toLocaleLowerCase().includes(term)&&!rows.includes(r))rows.push(r);
  rows.sort((a,b)=>layer==='hospitality'?(parentHospitality(b).score||0)-(parentHospitality(a).score||0):NEED_TYPES.indexOf(a.priority)-NEED_TYPES.indexOf(b.priority)||b.openCount-a.openCount);
  const list=$('#map-area-list');list.replaceChildren();for(const r of rows){
    const b=button('',()=>selectArea(r),'area-row'),mark=node('span',`area-icon ${!r.openCount?'unknown':layer==='hospitality'?'blue':''}`);mark.append(icon(layer==='hospitality'?'shelter':r.priority==='medical'?'medical':r.priority==='evacuation'?'pin':'supplies'));
    const copy=node('span','area-copy');copy.append(node('strong','',r.name),node('small','',layer==='hospitality'?'Demo suitability · needs inspection':r.openCount?`${title(r.priority)} · human review`:'No reports · coverage unknown'));b.append(mark,copy,node('span','area-count',layer==='hospitality'?`${parentHospitality(r).score??'—'}%`:count(metric(r))),icon('chevron'));list.append(b);
  }
  if(!rows.length)list.append(node('p','record-empty',term?'No matching neighborhoods. Try a shorter name.':'No areas in this list. Coverage checks remain available.'));
  if(queue==='priority'&&layer==='assistance'&&data.unlocatedRequests.length){const b=button('',showUnlocated,'area-row'),copy=node('span','area-copy');copy.append(node('strong','','Location needs review'),node('small','','Retained outside map totals'));b.append(copy,node('span','area-count',count(data.unlocatedRequests.length)),icon('chevron'));list.append(b);}
}
function showUnlocated(){closeDetail();revealDetail();const h=node('div','detail-heading');h.append(node('h2','','Location needs review'),iconButton('close','Close location review',closeDetail));detail.replaceChildren(h,node('p','detail-source','These requests remain open. They cannot be placed on the map until a location is established.'));for(const r of data.unlocatedRequests)detail.append(node('p','record-empty',`${r.id}: ${r.summary}`));detail.focus({preventScroll:true});}
function showPoi(poi){
  closeDetail();revealDetail();const header=node('div','detail-heading'),copy=node('div');copy.append(node('div','micro-label',`${title(poi.type)} / FICTIONAL FACILITY`),node('h2','',poi.name));header.append(copy,iconButton('close','Close facility details',closeDetail));detail.replaceChildren(header,node('p','detail-source',`${poi.region.name} · fictional location for this exercise`),node('span','pill blue','Planning only · not operational'));
  const list=node('dl','detail-breakdown');list.append(node('dt','','Resource'),node('dd','',poi.resource),node('dt','','Demo capacity'),node('dd','',poi.capacity),node('dt','','Status'),node('dd','','Not verified'));detail.append(list,node('p','detail-source','This marker is a fictional planning fixture. Availability, capacity, access, and agency approval have not been verified. It is not a direction to travel.'));detail.focus({preventScroll:true});
}
function renderPois(){
  poiLayer.replaceChildren();const enabled=[...document.querySelectorAll('input[name=poi]:checked')].map(e=>e.value);
  for(const poi of pois.filter(p=>enabled.includes(p.type))){
    const [x,y]=project(poi.point),g=svgNode('g',{class:'map-poi',tabindex:0,role:'button','aria-label':`${poi.name}, fictional ${poi.type}, not operational`});g.dataset.x=x;g.dataset.y=y;g.dataset.poiId=poi.id;
    g.append(svgNode('circle',{r:16,fill:'#fff',stroke:'#d3ded1','stroke-width':1.4}),svgNode('circle',{r:12.5,fill:poi.type==='medical'?'#f7eeeb':poi.type==='shelter'?'#edf2fb':'#eef3ed'}));const symbol=icon(poi.type);for(const [k,v]of Object.entries({x:-7,y:-7,width:14,height:14}))symbol.setAttribute(k,v);symbol.style.color=poi.type==='medical'?'#c77869':poi.type==='shelter'?'#6a8eb9':'#6f896b';g.append(symbol);
    g.addEventListener('click',e=>{if(!e.detail)showPoi(poi);});g.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();showPoi(poi);}});poiLayer.append(g);
  }setCamera(camera);
}
function initializeMap(){
  observer?.disconnect();root.replaceChildren();cells=new Map();paths=new Map();level=-1;
  const [west,south,east,north]=data.city.bbox,cos=Math.cos((north+south)/2*Math.PI/180),scale=Math.min(730/((east-west)*cos),570/(north-south)),width=(east-west)*cos*scale,height=(north-south)*scale;
  project=([lon,lat])=>[(800-width)/2+(lon-west)*cos*scale,(630-height)/2+(north-lat)*scale];
  svg=svgNode('svg',{class:'map-canvas',role:'group',tabindex:0,'aria-label':'Houston interactive response map. Drag to pan; scroll or pinch to zoom. Plus and minus zoom; arrows pan; zero fits Houston. Enter opens a focused area.'});
  const defs=svgNode('defs'),clip=svgNode('clipPath',{id:'city-clip'});clip.append(svgNode('path',{d:path(data.city.boundary),'clip-rule':'evenodd','fill-rule':'evenodd'}));defs.append(clip);
  const pattern=svgNode('pattern',{id:'unknown-hatch',width:7,height:7,patternUnits:'userSpaceOnUse'});pattern.append(svgNode('path',{d:'M-1 1L1-1M0 7L7 0M6 8L8 6',stroke:'#6c805e','stroke-width':.45,opacity:.5}));defs.append(pattern);
  for(const r of data.regions){const regionClip=svgNode('clipPath',{id:`clip-${r.id}`});regionClip.append(svgNode('path',{d:path(r.geometry),'clip-rule':'evenodd','fill-rule':'evenodd'}));defs.append(regionClip);cells.set(`${r.id}:0`,hospitalityForRegion(r,0));const placed=demoLocations(r);for(const l of [1,2])cells.set(`${r.id}:${l}`,buildSubtiles(r,l,placed));}svg.append(defs);
  const land=svgNode('g',{'clip-path':'url(#city-clip)'});land.append(svgNode('path',{d:path(data.city.boundary),class:'map-land','fill-rule':'evenodd'}));const basemap=data.basemap||{};
  if(basemap.available&&typeof basemap.url==='string'&&/^\/(?!\/)/.test(basemap.url)&&Array.isArray(basemap.bbox)){imagery=svgNode('image',{...rectangle(basemap.bbox),href:basemap.url,preserveAspectRatio:'none',opacity:Number($('#aerial-opacity').value)/100,class:'map-aerial'});imagery.addEventListener('error',()=>{imagery.remove();imagery=null;$('#imagery-provenance').textContent='Aerial image unavailable. Geographic boundaries remain visible.';});imagery.style.display=$('#basemap-select').value==='aerial'?'':'none';land.append(imagery);}else{imagery=null;$('#basemap-select').value='boundaries';$('#imagery-provenance').textContent=basemap.reason||'Aerial imagery unavailable. Geographic boundaries remain visible.';}
  paintLayer=svgNode('g',{'clip-path':'url(#city-clip)'});poiLayer=svgNode('g',{'aria-label':'Fictional facilities'});svg.append(land,paintLayer,svgNode('path',{d:path(data.city.boundary),fill:'none',stroke:'#859b7c','stroke-width':1,'vector-effect':'non-scaling-stroke','fill-rule':'evenodd','pointer-events':'none'}));
  const labels=svgNode('g',{'aria-hidden':'true'});for(const [i,r]of data.regions.entries())if(r.labelPoint&&(i<3||i%9===0)){const [x,y]=project(r.labelPoint),t=svgNode('text',{x,y,class:'map-place-name','font-size':5,'text-anchor':'middle'});t.dataset.size='9';t.textContent=r.name.toUpperCase();labels.append(t);}const [hx,hy]=project([-95.3698,29.7604]),cityLabel=svgNode('text',{x:hx,y:hy,class:'map-place-name','font-size':10,'font-weight':600,'text-anchor':'middle'});cityLabel.dataset.size='15';cityLabel.textContent='HOUSTON';labels.append(cityLabel);svg.append(labels,poiLayer);root.append(svg);
  const fixtures=[['supplies','Northside distribution hub','Water & essential supplies','240 kits',5],['shelter','West community shelter','Temporary hospitality','120 people',18],['medical','Central medical point','Medical assessment','24 stations',60],['supplies','East supply center','Food & essential supplies','180 kits',57],['shelter','South community hub','Temporary hospitality','90 people',42],['medical','North medical point','Medical assessment','12 stations',1]];
  pois=fixtures.flatMap(([type,name,resource,capacity,index],i)=>{const region=data.regions[index];return region?.labelPoint?[{id:`facility-${i}`,type,name,resource,capacity,region,point:region.labelPoint}]:[];});
  pointers.clear();gesture=null;bindGestures();observer=new ResizeObserver(entries=>{const r=entries[0].contentRect;if(r.width&&r.height){const changed=Math.abs(r.width-mapSize.width)>1||Math.abs(r.height-mapSize.height)>1;mapSize={width:r.width,height:r.height};if(changed&&!selected)fitHouston();else setCamera(camera);}});observer.observe(frame);renderMetrics();renderQueue();renderPois();fitHouston();$('#map-source').textContent=`Houston city boundaries · ${basemap.attribution||'USGS / USDA NAIP'} · historical`;
}
function bindGestures(){
  let suppressClick=false;const begin=()=>{gesture=startGesture(camera,[...pointers.values()],screenPoint,800/mapSize.width/camera.zoom);};
  svg.addEventListener('pointerdown',e=>{if(e.button!==0)return;stopAnimation();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY,target:e.target.closest('[data-region-id], [data-poi-id]')});begin();svg.setPointerCapture(e.pointerId);});
  svg.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId)||!gesture)return;pointers.set(e.pointerId,{...pointers.get(e.pointerId),x:e.clientX,y:e.clientY});const next=moveGesture(gesture,[...pointers.values()]);if(gesture.moved){tooltip.hidden=true;svg.classList.add('is-panning');if(renderFrame)cancelAnimationFrame(renderFrame);renderFrame=requestAnimationFrame(()=>{setCamera(next);renderFrame=0;});}});
  const end=(e,cancel=false)=>{
    if(!pointers.has(e.pointerId))return;const target=!cancel&&!gesture?.moved&&pointers.size===1?pointers.get(e.pointerId).target:null;
    if(renderFrame){cancelAnimationFrame(renderFrame);renderFrame=0;setCamera(moveGesture(gesture,[...pointers.values()]));}suppressClick=true;pointers.delete(e.pointerId);if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);svg.classList.remove('is-panning');if(pointers.size){begin();gesture.moved=true;}else gesture=null;
    if(target?.dataset.poiId)showPoi(pois.find(p=>p.id===target.dataset.poiId));else if(target?.dataset.regionId){const region=data.regions.find(r=>r.id===target.dataset.regionId),cell=target.dataset.cellId?[...(cells.get(`${region.id}:1`)||[]),...(cells.get(`${region.id}:2`)||[])].find(c=>c.id===target.dataset.cellId):null;selectArea(region,cell);}
  };
  svg.addEventListener('pointerup',e=>end(e));svg.addEventListener('pointercancel',e=>end(e,true));svg.addEventListener('lostpointercapture',e=>{if(pointers.has(e.pointerId))end(e,true);});svg.addEventListener('click',e=>{if(suppressClick&&e.detail){e.stopPropagation();e.preventDefault();suppressClick=false;}},true);
  svg.addEventListener('wheel',e=>{e.preventDefault();stopAnimation();tooltip.hidden=true;setCamera(zoomAt(camera,Math.exp(-Math.max(-140,Math.min(140,e.deltaY))*.0035),screenPoint(e.clientX,e.clientY)));},{passive:false});svg.addEventListener('dblclick',e=>{if(e.target===svg){e.preventDefault();setCamera(zoomAt(camera,1.8,screenPoint(e.clientX,e.clientY)));}});
  svg.addEventListener('keydown',e=>{stopAnimation();let next;if(['+','='].includes(e.key))next=zoomAt(camera,1.5);if(e.key==='-')next=zoomAt(camera,1/1.5);const d=60*800/mapSize.width/camera.zoom;if(e.key==='ArrowLeft')next={...camera,x:camera.x-d};if(e.key==='ArrowRight')next={...camera,x:camera.x+d};if(e.key==='ArrowUp')next={...camera,y:camera.y-d};if(e.key==='ArrowDown')next={...camera,y:camera.y+d};if(e.key==='0'||e.key==='Escape'){e.preventDefault();fitHouston(true);return;}if(next){e.preventDefault();setCamera(next);}});
}
async function load(){
  stopAnimation();const id=++loadId;status.hidden=false;status.textContent='Loading Houston…';closeDetail();
  try{const response=await fetch(`/api/houston?scenario=${encodeURIComponent($('#houston-scenario').value)}`),next=await response.json();if(id!==loadId)return;if(!response.ok||!next.available)throw new Error(next.reason||next.error||'Houston data is unavailable.');data=next;initializeMap();status.hidden=true;}catch(e){if(id!==loadId)return;observer?.disconnect();svg=null;paintLayer=null;poiLayer=null;root.replaceChildren();status.replaceChildren(node('span','',e.message),button('Try again',load));}
}
for(const mode of ['assistance','hospitality'])$('#layer-'+mode).addEventListener('click',()=>{layer=mode;for(const m of ['assistance','hospitality'])$('#layer-'+m).setAttribute('aria-pressed',String(m===mode));$('#need-filter').hidden=mode==='hospitality';$('#layer-description').textContent=mode==='hospitality'?'Bluer tiles show higher demo suitability. Utility and access inputs need inspection.':'Redder tiles have more open requests. Zoom in to see smaller areas.';if(svg){renderTiles();renderQueue();if(selected)selectArea(selected.region,selected.cell,false);}});
$('#need-filter').addEventListener('change',e=>{filter=e.target.value;if(svg){renderTiles();renderQueue();if(selected)selectArea(selected.region,selected.cell,false);}});
for(const type of ['priority','coverage'])$('#queue-'+type).addEventListener('click',()=>{queue=type;for(const q of ['priority','coverage'])$('#queue-'+q).setAttribute('aria-selected',String(q===type));$('#map-area-list').setAttribute('aria-label',type==='priority'?'Priority areas':'Coverage checks');renderQueue();});
$('#map-search').addEventListener('input',renderQueue);$('#houston-scenario').addEventListener('change',load);$('#map-zoom-in').addEventListener('click',()=>{if(svg)animateCamera(zoomAt(camera,1.6));});$('#map-zoom-out').addEventListener('click',()=>{if(svg)animateCamera(zoomAt(camera,1/1.6));});$('#map-fit').addEventListener('click',()=>fitHouston(true));$('#city-fit').addEventListener('click',()=>{location.hash='mayor';fitHouston(true);});
for(const input of document.querySelectorAll('input[name=poi]'))input.addEventListener('change',()=>{if(svg)renderPois();});
$('#imagery-toggle').addEventListener('click',()=>{const panel=$('#imagery-panel');panel.hidden=!panel.hidden;$('#imagery-toggle').setAttribute('aria-expanded',String(!panel.hidden));});document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('#imagery-panel').hidden=true;$('#imagery-toggle').setAttribute('aria-expanded','false');frame.classList.remove('panel-open');$('#mobile-panel-toggle').setAttribute('aria-expanded','false');}});
$('#basemap-select').addEventListener('change',e=>{if(imagery)imagery.style.display=e.target.value==='aerial'?'':'none';});$('#aerial-opacity').addEventListener('input',e=>{if(imagery)imagery.setAttribute('opacity',Number(e.target.value)/100);});$('#tile-opacity').addEventListener('input',()=>{if(svg)renderTiles();});$('#mobile-panel-toggle').addEventListener('click',()=>{if(mobile()){const open=frame.classList.toggle('panel-open');$('#mobile-panel-toggle').setAttribute('aria-expanded',String(open));}else{frame.classList.remove('overview-collapsed');$('#mobile-panel-toggle').setAttribute('aria-expanded','true');setCamera(camera);}});
$('#desktop-panel-close').addEventListener('click',()=>{frame.classList.add('overview-collapsed');$('#mobile-panel-toggle').setAttribute('aria-expanded','false');$('#mobile-panel-toggle').focus();});
$('#map-search').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#map-area-list .area-row')?.click();}if(e.key==='Escape'&&e.target.value){e.preventDefault();e.target.value='';renderQueue();}});
document.addEventListener('keydown',e=>{if(e.key==='/'&&!frame.hidden&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){e.preventDefault();frame.classList.remove('overview-collapsed');if(mobile()){frame.classList.add('panel-open');$('#mobile-panel-toggle').setAttribute('aria-expanded','true');}$('#map-search').focus();}});
load();

for(const id of ['priority','coverage'])$('#queue-'+id).addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const target=e.key==='Home'?'priority':e.key==='End'?'coverage':id==='priority'?'coverage':'priority';$('#queue-'+target).click();$('#queue-'+target).focus();}});
