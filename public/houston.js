import {node,button,svgNode,icon,iconButton,title,count} from './ui.js';
import {geometryOf,geometryBounds,demoLocations,buildSubtiles,detailLevel,cameraView,zoomAt as boundedZoom,fitMapCamera,fitMapCameraWithPanel,resizeMapCamera,startGesture,moveGesture,hospitalityFixture,hospitalityForRegion,searchMapRecords,planningFacilities,fixtureImageryContext,boundCameraToExtent,NEED_TYPES,MAX_MAP_ZOOM} from './map-model.js';
import {createReferenceLayer} from './reference-layer.js';
import {createImageryDetailLayer} from './imagery-layer.js';
import {createHistoricalLayer} from './historical-layer.js';
import {createObservationView} from './observation-view.js';
const $=s=>document.querySelector(s);
const ASSISTANCE_SCALE_MAX=300;
const root=$('#houston-content'),status=$('#houston-status'),frame=$('#map-view');
let data,svg,project,unproject,paths=new Map(),cells=new Map(),pois=[],mapSize={width:1000,height:700};
let activePoiId=null,cameraFitted=true,referenceLayer=null,detailImagery=null,historicalLayer=null;
let imageryMode='aerial',imageryModeTouched=false,historicalDefaultsApplied=false,imageryOpacityTouched=false,overlayOpacityTouched=false,captureDates={water:'2017-09-01','event-rgb':'2017-09-01',flood:'2017-08-31',radar:'2017-08-29'};
let imageryStatus={kind:'overview',label:'Historical imagery'};
let camera={x:400,y:315,zoom:1},level=-1,layer='assistance',filter='all',queue='priority',selected=null,loadId=0;
let fixtureFitBounds=null;
let paintLayer,poiLayer,imagery,gesture=null,observer,renderFrame=0,animationFrame=0;
const observationView=createObservationView($('#map-observation'),{
  onDate(date){const control=$('#capture-date');if([...control.options].some(option=>option.value===date)){control.value=date;control.dispatchEvent(new Event('change',{bubbles:true}));}},
  onShow(){setImageryOpacity(100);imageryOpacityTouched=true;updateMapResolution();},
  onFocusMap(){if(!frame.hidden)svg?.focus({preventScroll:true});},
  onLayout(){if(svg)requestAnimationFrame(()=>setCamera(camera,cameraFitted));}
});
const pointers=new Map(),detail=$('#map-detail'),tooltip=$('#map-tooltip');
const compactMapLayout=window.matchMedia('(max-width:760px), (max-height:520px)');
const mobile=()=>compactMapLayout.matches;
const allowsMapShortcut=event=>!event.defaultPrevented&&!event.isComposing&&!event.ctrlKey&&!event.metaKey&&!event.altKey;
const sidebarWidth=()=>mobile()||frame.classList.contains('overview-collapsed')?0:document.querySelector('#operations-panel').getBoundingClientRect().right-frame.getBoundingClientRect().left+20;
const parentHospitality=r=>cells.get(`${r.id}:0`)?.[0]?.hospitality||hospitalityFixture(`${r.id}/0/0/0`);
function revealDetail(){detail.hidden=false;if(mobile()){frame.classList.remove('panel-open');$('#mobile-panel-toggle').setAttribute('aria-expanded','false');}}
function updateBreadcrumb(){const trail=$('#map-breadcrumb');trail.replaceChildren();trail.hidden=!selected;if(!selected)return;trail.append(button('Houston',()=>fitHouston(true),'breadcrumb-button'),icon('chevron'));const name=button(selected.region.name,()=>selectArea(selected.region),'breadcrumb-button');trail.append(name);if(selected.cell){trail.append(icon('chevron'),node('span','breadcrumb-current',selected.cell.name.split(' · ').at(-1)));}}
function reconcileAreas(){if(!svg||!paintLayer)return;const v=cameraView(camera,mapSize.width,mapSize.height);for(const area of paintLayer.querySelectorAll('[data-region-id]')){const b=JSON.parse(area.dataset.bounds),visible=b.x<v.x+v.width&&b.x+b.width>v.x&&b.y<v.y+v.height&&b.y+b.height>v.y;const pressed=selected?.region.id===area.dataset.regionId&&(selected.cell?selected.cell.id===area.dataset.cellId:!area.dataset.cellId);area.setAttribute('tabindex',visible?'0':'-1');area.setAttribute('aria-pressed',String(pressed));area.classList.toggle('is-selected',pressed);}for(const [id,path]of paths)path.classList.toggle('is-selected',selected?.region.id===id&&!selected.cell);for(const marker of poiLayer?.children||[]){const x=Number(marker.dataset.x),y=Number(marker.dataset.y);const visible=x>=v.x&&x<=v.x+v.width&&y>=v.y&&y<=v.y+v.height;marker.setAttribute('tabindex',visible?'0':'-1');}}
const metric=item=>filter==='all'?item.openCount:item.categories?.[filter]||0;
const alpha=()=>Number($('#tile-opacity').value)/100;
const polygons=value=>{const g=geometryOf(value);return g?.type==='Polygon'?[g.coordinates]:g?.type==='MultiPolygon'?g.coordinates:[];};
function path(g){return polygons(g).flatMap(p=>p.map(r=>r.map((v,i)=>`${i?'L':'M'}${project(v).map(n=>n.toFixed(3)).join(',')}`).join('')+'Z')).join('');}
function rectangle(bounds){const a=project([bounds[0],bounds[3]]),b=project([bounds[2],bounds[1]]);return {x:a[0],y:a[1],width:b[0]-a[0],height:b[1]-a[1]};}
function footerHeight(){return document.querySelector('.map-footer').getBoundingClientRect().height||32;}
function cityFitCamera(){return fitMapCamera(rectangle(data.city.bbox),mapSize.width,mapSize.height,{left:sidebarWidth(),bottom:footerHeight(),padding:24});}
function minimumCameraZoom(){return Math.min(.4,cityFitCamera().zoom);}
function zoomAt(current,factor,anchor){return boundedZoom(current,factor,anchor,minimumCameraZoom());}
function screenPoint(x,y){const p=svg.createSVGPoint();p.x=x;p.y=y;return p.matrixTransform(svg.getScreenCTM().inverse());}
function declutterLabels(unit,controls=[]){
  const v=cameraView(camera,mapSize.width,mapSize.height),occupied=[...controls,...(referenceLayer?.occupied||[])];
  const overlaps=(a,b)=>a.x<b.x+b.width&&a.x+a.width>b.x&&a.y<b.y+b.height&&a.y+a.height>b.y;
  for(const marker of poiLayer.children){const x=Number(marker.dataset.x),y=Number(marker.dataset.y);occupied.push({x:x-18*unit,y:y-18*unit,width:36*unit,height:36*unit});}
  const labels=[...svg.querySelectorAll('.map-place-name')].sort((a,b)=>Number(a.dataset.rank)-Number(b.dataset.rank));
  for(const text of labels){text.style.display='';text.removeAttribute('transform');const b=text.getBBox(),pad=3*unit;let placed=false;
    for(const dy of (text.dataset.rank==='0'?[0,-24*unit,24*unit,-48*unit,48*unit,-72*unit,72*unit]:[0,-14*unit,14*unit])){const r={x:b.x-pad,y:b.y+dy-pad,width:b.width+2*pad,height:b.height+2*pad};const inside=r.x>=v.x&&r.x+r.width<=v.x+v.width&&r.y>=v.y&&r.y+r.height<=v.y+v.height;if(inside&&!occupied.some(other=>overlaps(r,other))){if(dy)text.setAttribute('transform',`translate(0 ${dy})`);occupied.push(r);placed=true;break;}}
    if(!placed)text.style.display='none';
  }
}
function updateMapResolution(){
  const resolution=$('#map-resolution');
  const area=['Neighborhood view','Subtiles · level 1','Subtiles · level 2'][Math.max(0,level)],areaLabel=resolution.querySelector('.area-resolution'),imageLabel=resolution.querySelector('.aerial-resolution');
  if(areaLabel.textContent!==area)areaLabel.textContent=area;
  if(imageLabel.textContent!==imageryStatus.label)imageLabel.textContent=imageryStatus.label;
  let bbox=null;
  if(svg&&unproject){
    const view=cameraView(camera,mapSize.width,mapSize.height),unit=800/mapSize.width/camera.zoom;
    const left=Math.min(sidebarWidth(),mapSize.width-1)*unit,bottom=Math.min(footerHeight(),mapSize.height-1)*unit;
    const a=unproject([view.x+left,view.y+Math.max(unit,view.height-bottom)]),b=unproject([view.x+view.width,view.y]);bbox=[a[0],a[1],b[0],b[1]];
  }
  observationView.update({mode:svg?imageryMode:'boundaries',date:imageryStatus.date||captureDates[imageryMode],bbox,
    dates:historicalLayer?.dates(imageryMode).map(item=>item.value)||[],imageState:imageryStatus.kind,opacity:Number($('#aerial-opacity').value)});
}
function setImageryOpacity(value){
  const percentage=Math.max(0,Math.min(100,Number(value)||0));$('#aerial-opacity').value=String(percentage);
  for(const group of [imagery,historicalLayer?.element])group?.setAttribute('opacity',percentage/100);
}
function reportImagery(state){
  if(imageryMode!=='aerial')return;
  imageryStatus=state;if(svg)updateMapResolution();
  $('#imagery-detail-status').textContent=state.kind==='unavailable'?'Sharper imagery could not load. The overview remains visible.':state.kind==='ready'?state.label+' · cached locally.':state.kind==='loading'?'Loading sharper imagery for this view…':'Sharper imagery appears as you zoom into Houston.';
  const retry=$('#imagery-detail-retry');retry.hidden=state.kind!=='unavailable';
}
const isHistorical=mode=>['water','event-rgb','flood','radar'].includes(mode);
function historicalStatus(state){
  if(state.source==='history-metadata'){
    const retry=$('#history-retry');if(state.kind==='loading'&&document.activeElement===retry)retry.dataset.restoreFocus='true';retry.disabled=state.kind==='loading';
    if(state.kind==='unavailable'){$('#historical-note').hidden=false;$('#historical-note').textContent='Dated imagery could not load. Reference imagery remains available.';retry.hidden=false;}
    return;
  }
  if(state.mode!==imageryMode)return;
  if(state.date&&captureDates[state.mode]!==state.date){captureDates[state.mode]=state.date;refreshCaptureDates();}
  imageryStatus=state;if(svg)updateMapResolution();
  const scene=state.scene;
  if(scene){
    const percentage=Number.isFinite(scene.validFraction)?`${Math.round(scene.validFraction*100)}% of the mapped Houston extent has clear observations. `:'';
    $('#historical-note').textContent=state.mode==='water'?`${percentage}Green B03 + SWIR B11, analyzed at 20 m. Cyan emphasizes open water, including rivers and lakes; it does not isolate newly flooded ground. Floodwater mixed with buildings or vegetation can be missed. Dimmed context marks clouds, shadows or missing observations. Use Show flooding for dated street imagery.`:state.mode==='event-rgb'?`${percentage}Same-date Sentinel-2 true color. Dimmed context marks unavailable observations; reference imagery underneath supplies orientation.`:state.mode==='radar'?'NASA/JPL probable inundation from Sentinel-1 radar, August 5–29, 2017. Blue marks proxy indications; unmarked areas are unknown. Reliability is lower in urban areas.':'NOAA flood-date aerial imagery. Dimmed context marks missing flight coverage; reference imagery underneath is context, not evidence of dry ground.';
    $('#map-source').textContent=state.outsideCapture?'Outside the selected capture · reference imagery is context':state.mode==='flood'?`NOAA NGS · ${scene.date} · partial flight coverage · Harvey 2017`:state.mode==='radar'?'NASA/JPL ARIA · Sentinel-1 radar · August 29, 2017 · 30 m flood proxy':`Copernicus Sentinel-2 · ${scene.date} · ${state.mode==='water'?'B03 / B11 water emphasis':'true color'} · 20 m`;
  }else if(state.reason==='no-capture'){
    $('#historical-note').textContent='No dated capture is available for this mode. Reference imagery provides context; flood status remains unknown.';
    $('#map-source').textContent='Reference imagery only · no dated capture · flood status unknown';
  }
  $('#imagery-detail-status').textContent=state.reason==='no-capture'?'No dated capture is available. Retry to refresh the available captures.':state.kind==='loading'?'Loading dated imagery…':state.kind==='unavailable'?'This historical image could not load. Use Retry or choose another capture.':state.label;
  $('#imagery-detail-retry').hidden=state.kind!=='unavailable';
}
function refreshCaptureDates(){
  const control=$('#capture-date');control.replaceChildren();
  for(const option of historicalLayer?.dates(imageryMode)||[]){const item=node('option','',option.label);item.value=option.value;control.append(item);}
  control.value=[...control.options].some(option=>option.value===captureDates[imageryMode])?captureDates[imageryMode]:'';
  control.disabled=!control.options.length;
  $('#capture-date-label').hidden=!isHistorical(imageryMode);$('#historical-note').hidden=!isHistorical(imageryMode);
}
function focusHistoricalExample(index=0){
  if(!historicalLayer||!svg)return;
  const examples=imageryMode==='flood'?historicalLayer.hotspots():[
    {date:'2017-08-30',bbox:[-95.72191,29.74472,-95.69548,29.76780],label:'Barker Reservoir / Baker Road'},
    {date:'2017-09-01',bbox:[-95.25104,30.00439,-95.22461,30.02748],label:'West Fork San Jacinto / North Houston Avenue'}
  ];
  const example=examples[index];if(!example)return;
  if(imageryMode!=='radar'){captureDates[imageryMode]=example.date;refreshCaptureDates();historicalLayer.setDate(example.date);}
  closeDetail();focusBounds(example.bbox);$('#imagery-panel').hidden=true;$('#imagery-toggle').setAttribute('aria-expanded','false');
  if(mobile()){frame.classList.remove('panel-open');$('#mobile-panel-toggle').setAttribute('aria-expanded','false');}
  svg.focus({preventScroll:true});setCamera(camera,cameraFitted);
}
function applyImageryMode(mode){
  const previousMode=imageryMode;
  if(['water','event-rgb'].includes(mode)&&['water','event-rgb'].includes(previousMode))captureDates[mode]=captureDates[previousMode];
  if(['water','event-rgb'].includes(mode)&&previousMode==='flood'&&historicalLayer?.dates(mode).some(item=>item.value===captureDates.flood)){captureDates.water=captureDates.flood;captureDates['event-rgb']=captureDates.flood;}
  imageryMode=mode;$('#basemap-select').value=mode;
  if(imagery)imagery.style.display=mode==='boundaries'?'none':'';
  setImageryOpacity($('#aerial-opacity').value);
  detailImagery?.setEnabled(mode!=='boundaries');const resolvedDate=historicalLayer?.setMode(mode,captureDates[mode]);
  if(isHistorical(mode)&&resolvedDate)captureDates[mode]=resolvedDate;
  historicalLayer?.element.setAttribute('opacity',Number($('#aerial-opacity').value)/100);
  $('#imagery-provenance').textContent=mode==='water'||mode==='event-rgb'?'Contains modified Copernicus Sentinel data (2017). Same-date scenes; clouds and shadows are masked.':mode==='flood'?'NOAA NGS aerial photographs acquired during the Harvey response, August–September 2017.':mode==='radar'?'NASA/JPL ARIA flood proxy from Copernicus Sentinel-1 observations, August 2017.':mode==='boundaries'?'Official Houston boundaries. No imagery is shown.':'USGS / USDA 2017–2021 aerial detail with NASA 2004 regional context. Reference imagery does not establish flood conditions.';
  frame.classList.toggle('water-view',mode==='water');frame.classList.toggle('event-view',isHistorical(mode));
  refreshCaptureDates();$('#water-map-key').hidden=!['water','radar'].includes(mode);$('#historical-example').hidden=!isHistorical(mode);$('#capture-unknown-key').hidden=!isHistorical(mode);
  $('#water-map-key').classList.toggle('radar-key',mode==='radar');
  $('#capture-unknown-key span').textContent=mode==='radar'?'Unmarked flood status is unknown':'Dimmed · no observation; flood status unknown';
  $('#water-key-text').textContent=mode==='radar'?'Blue · probable inundation proxy':'Cyan · stronger open-water signal';
  const examples=$('#historical-focuses');examples.replaceChildren();
  if(mode==='flood')for(const [i,asset]of (historicalLayer?.hotspots()||[]).entries())examples.append(button(`${asset.label} · ${asset.date.slice(5)}`,()=>focusHistoricalExample(i),'control'));
  else if(mode==='water'||mode==='event-rgb')for(const [i,label]of ['Barker / Baker Road · Aug 30','West Fork / N Houston Ave · Sep 1'].entries())examples.append(button(label,()=>focusHistoricalExample(i),'control'));
  examples.hidden=!examples.children.length;
  if(mode==='aerial'){$('#map-source').textContent='NASA / USGS / USDA · historical reference imagery · capture dates vary';if(svg)detailImagery?.update(cameraView(camera,mapSize.width,mapSize.height),mapSize);}
  if(mode==='boundaries'){imageryStatus={kind:'hidden',label:'Geographic boundaries only'};updateMapResolution();$('#map-source').textContent='City of Houston official geographic boundaries';}
  if(svg)setCamera(camera,cameraFitted);
}
function historicalReady(controller){
  const available=controller.available;
  const retry=$('#history-retry');if(document.activeElement===retry||retry.dataset.restoreFocus==='true')$('#basemap-select').focus({preventScroll:true});delete retry.dataset.restoreFocus;retry.hidden=true;
  for(const option of $('#basemap-select').options){if(option.value==='water')option.disabled=!available.water;if(option.value==='event-rgb')option.disabled=!available.rgb;if(option.value==='flood')option.disabled=!available.flood;if(option.value==='radar')option.disabled=!available.radar;}
  $('#show-flooding').disabled=!controller.hotspots().length;
  $('#show-flooding').title=controller.hotspots().length?'Open available flood-date street imagery':'Flooded-street detail is unavailable. Dated overviews remain in Imagery.';
  if(!historicalDefaultsApplied&&!imageryModeTouched&&(available.radar||available.water)){imageryMode=available.radar?'radar':'water';if(!imageryOpacityTouched){$('#aerial-opacity').value='100';imagery?.setAttribute('opacity','1');}if(!overlayOpacityTouched)$('#tile-opacity').value='35';historicalDefaultsApplied=true;renderTiles();}
  applyImageryMode(imageryMode);
  for(const action of detail.querySelectorAll('[data-fixture-capture]'))action.disabled=!controller.hotspots().some(image=>image.id===action.dataset.fixtureImagery&&image.date===action.dataset.fixtureCapture);
}
function referenceStatus(state){
  $('#map-reference-status').textContent=state==='ready'?'City of Houston / USGS map references. No access or operating status is implied.':state==='unavailable'?'Street and landmark references could not load.':'Loading street and landmark references…';
  const retry=$('#map-reference-retry');retry.disabled=state==='loading';
  if(state==='ready'&&document.activeElement===retry)$('#map-streets').focus({preventScroll:true});
  if(state==='unavailable')retry.hidden=false;else if(state==='ready')retry.hidden=true;
}
function setCamera(next,fitted=false){
  if(!svg||!data)return;
  cameraFitted=fitted;
  const coverage=data.contextBasemaps?.find(image=>image.available&&image.kind==='world');
  camera=coverage?boundCameraToExtent(next,rectangle(coverage.bbox),mapSize.width,mapSize.height):next;const v=cameraView(camera,mapSize.width,mapSize.height);
  svg.setAttribute('viewBox',`${v.x} ${v.y} ${v.width} ${v.height}`);
  $('#map-zoom-in').disabled=camera.zoom>=MAX_MAP_ZOOM;$('#map-zoom-out').disabled=camera.zoom<=minimumCameraZoom()+1e-9;
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
  if(imageryMode!=='boundaries')detailImagery?.update(v,mapSize);historicalLayer?.update(v,mapSize);updateMapResolution();
  const controls=[],obstacles=[...poiLayer.children].map(marker=>({x:Number(marker.dataset.x)-19*unit,y:Number(marker.dataset.y)-19*unit,width:38*unit,height:38*unit}));
  for(const control of frame.querySelectorAll('.operations-panel,.imagery-panel,.map-top-controls,#show-flooding,.map-legend-card,.map-resolution,.map-detail,.map-breadcrumb,.map-fit,.map-zoom-controls,.mobile-panel-toggle,.map-footer')){
    if(!control.getClientRects().length||getComputedStyle(control).visibility==='hidden')continue;
    const b=control.getBoundingClientRect(),a=screenPoint(b.left,b.top),end=screenPoint(b.right,b.bottom);
    const box={x:a.x-4*unit,y:a.y-4*unit,width:end.x-a.x+8*unit,height:end.y-a.y+8*unit};obstacles.push(box);controls.push(box);
  }
  referenceLayer?.update(v,unit,obstacles);declutterLabels(unit,controls);
}
function stopAnimation(){if(animationFrame)cancelAnimationFrame(animationFrame);animationFrame=0;}
function animateCamera(target){fixtureFitBounds=null;stopAnimation();if(window.matchMedia('(prefers-reduced-motion:reduce)').matches){setCamera(target);return;}const start={...camera},at=performance.now();const tick=now=>{const t=Math.min(1,(now-at)/220),ease=1-(1-t)**3;setCamera({x:start.x+(target.x-start.x)*ease,y:start.y+(target.y-start.y)*ease,zoom:start.zoom+(target.zoom-start.zoom)*ease});if(t<1)animationFrame=requestAnimationFrame(tick);else animationFrame=0;};animationFrame=requestAnimationFrame(tick);}
function fitHouston(focus=false){
  fixtureFitBounds=null;
  stopAnimation();
  if(!svg)return;
  setCamera(cityFitCamera(),true);closeDetail();if(focus)svg.focus({preventScroll:true});
}
function focusBounds(bounds,zoomFloor=0,{visibleDetail=false}={}){
  stopAnimation();
  fixtureFitBounds=visibleDetail?{bounds:[...bounds],zoomFloor}:null;
  const r=rectangle(bounds),insets={left:sidebarWidth(),right:0,bottom:footerHeight(),padding:38};
  let panelBox=null;
  if(visibleDetail&&!detail.hidden){
    const panel=detail.getBoundingClientRect(),map=frame.getBoundingClientRect();
    panelBox={x:panel.left-map.left,y:panel.top-map.top,width:panel.width,height:panel.height};
    if(!mobile()&&insets.left&&panel.left-map.left-insets.left-12<280){
      frame.classList.add('overview-collapsed');$('#mobile-panel-toggle').setAttribute('aria-expanded','false');insets.left=0;
    }
    for(const control of frame.querySelectorAll('.map-top-controls,.mobile-panel-toggle,.map-breadcrumb,#show-flooding')){
      if(!control.getClientRects().length||getComputedStyle(control).visibility==='hidden')continue;
      insets.top=Math.max(insets.top||0,control.getBoundingClientRect().bottom-map.top+8);
    }
  }
  let next=panelBox?fitMapCameraWithPanel(r,mapSize.width,mapSize.height,panelBox,insets):fitMapCamera(r,mapSize.width,mapSize.height,insets);
  if(zoomFloor>next.zoom)next=zoomAt(next,zoomFloor/next.zoom,{x:r.x+r.width/2,y:r.y+r.height/2});
  setCamera(next);
}
function closeDetail(){fixtureFitBounds=null;detail.hidden=true;selected=null;activePoiId=null;for(const p of poiLayer?.children||[])p.classList.remove('is-selected');reconcileAreas();updateBreadcrumb();if(svg)setCamera(camera,cameraFitted);}
function dismissDetail(){closeDetail();svg?.focus({preventScroll:true});}
function showTooltip(item,event){
  if(event?.type==='pointerenter'&&Number.isFinite(event.clientX)&&Number.isFinite(event.clientY)){const b=$('#map-resolution').getBoundingClientRect();if(event.clientX>=b.left&&event.clientX<=b.right&&event.clientY>=b.top&&event.clientY<=b.bottom){tooltip.hidden=true;return;}}
  const value=layer==='assistance'?`${count(metric(item))} open requests`:(item.hospitality?.score==null?'Suitability unknown':`${item.hospitality.score}% planning suitability`);
  tooltip.replaceChildren(node('strong','',item.name),node('span','',value));tooltip.hidden=false;
  const b=frame.getBoundingClientRect(),target=event?.target?.getBoundingClientRect();
  const x=event?.clientX??target?.x??b.width/2,y=event?.clientY??target?.y??b.height/2;
  tooltip.style.left=`${Math.min(b.width-265,Math.max(12,x-b.x+14))}px`;tooltip.style.top=`${Math.min(b.height-90,Math.max(65,y-b.y-70))}px`;
}
function areaData(region,cell=null){return cell||{...region,hospitality:parentHospitality(region)};}
function appendFixtureImagery(parent,locations){
  const context=fixtureImageryContext(locations);if(!context)return;
  parent.append(node('p','detail-source',`Fictional planning locations · NOAA aerial context ${context.imageryDate}. Historical imagery does not establish actual reports or facility operation.`));
  const action=button('View flood imagery',()=>{
    if(!historicalLayer?.hotspots().some(image=>image.id===context.imageryId&&image.date===context.imageryDate))return;
    imageryModeTouched=true;imageryOpacityTouched=true;$('#aerial-opacity').value='100';captureDates.flood=context.imageryDate;applyImageryMode('flood');
    focusBounds(context.bounds,0,{visibleDetail:true});if(svg)setCamera(camera,cameraFitted);
  },'control');
  action.dataset.fixtureCapture=context.imageryDate;
  action.dataset.fixtureImagery=context.imageryId;
  action.disabled=!historicalLayer?.hotspots().some(image=>image.id===context.imageryId&&image.date===context.imageryDate);
  action.title=`View NOAA ${context.imageryDate} imagery around these fictional locations`;
  parent.append(action);
}
function selectArea(region,cell=null){
  if(!svg||!region)return;
  activePoiId=null;for(const p of poiLayer.children)p.classList.remove('is-selected');
  selected={region,cell};tooltip.hidden=true;
  focusBounds(cell?.bounds||geometryBounds(region.geometry),cell?Math.max(5,camera.zoom*1.4):0);
  reconcileAreas();updateBreadcrumb();
  revealDetail();renderAreaDetail(region,cell);detail.focus({preventScroll:true});if(svg)setCamera(camera,cameraFitted);
}
function renderAreaDetail(region,cell){
  const item=areaData(region,cell);
  const header=node('div','detail-heading'),copy=node('div');copy.append(node('div','micro-label',cell?'HOUSTON / SUBTILE':'HOUSTON / NEIGHBORHOOD'),node('h2','',item.name));
  header.append(copy,iconButton('close','Close area details',dismissDetail));detail.replaceChildren(header);
  if(layer==='assistance'){
    const total=node('div','detail-total',count(metric(item)));total.append(node('small','','open requests'));detail.append(total);
    const breakdown=node('dl','detail-breakdown');for(const c of NEED_TYPES){const dt=node('dt');dt.append(node('i'),document.createTextNode(title(c)));breakdown.append(dt,node('dd','',count(item.categories?.[c])));}detail.append(breakdown);
    detail.append(node('span',`pill ${item.openCount?'red':''}`,item.openCount?'Reported needs · fictional':'Unknown coverage · check needed'));
    detail.append(node('p','detail-source',cell?'Fixed fictional locations roll up to the neighborhood total; zooming does not redistribute reports.':'Unique open requests. Categories may overlap. Volume does not establish severity or safety.'));
    if(!cell)for(const request of data.urgentRequests.filter(r=>r.regionId===region.id))detail.append(node('p','urgent-case-note',`Urgent individual review · ${request.summary}`));
    const locations=Array.isArray(region.requestLocations)?demoLocations(region).filter(location=>!cell||location.point&&location.point[0]>=cell.bounds[0]&&location.point[0]<=cell.bounds[2]&&location.point[1]>=cell.bounds[1]&&location.point[1]<=cell.bounds[3]):[];
    appendFixtureImagery(detail,locations);
  }else{
    const h=item.hospitality,total=node('div','detail-total',h.score==null?'—':`${h.score}%`);total.append(node('small','','planning suitability'));detail.append(total);
    const list=node('dl','detail-breakdown');for(const [name,key] of [['Power','power'],['Water','water'],['Access','access']])list.append(node('dt','',name),node('dd','',h[key]==null?(h.utilityCoverage?.[key]?.unknown===100?'Unknown':`${h.utilityCoverage?.[key]?.available??0}% available`):h[key]?'Available':'Unavailable'));list.append(node('dt','','Demo capacity'),node('dd','',h.capacity==null?'Unknown':`${count(h.capacity)} known places`));detail.append(list,node('span','pill blue',`Demo inputs · ${h.coverage??0}% coverage`),node('p','detail-source','Blue reflects area-weighted fictional utility and access inputs. Unknown parts are excluded from the score; known capacity is conserved as you zoom. A site inspection and agency approval are required before use as a shelter. Building imagery alone does not establish suitability.'));
  }
  const actions=node('div','detail-actions');if(cell)actions.append(button('Neighborhood',()=>selectArea(region),'control'));else actions.append(button('Explore subtiles',()=>focusBounds(geometryBounds(region.geometry),Math.max(5,camera.zoom*1.4)),'control'));
  actions.append(button('Back to Houston',()=>fitHouston(true),'control'));detail.append(actions);
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
  const max=ASSISTANCE_SCALE_MAX;
  const fill=item=>layer==='hospitality'?(item.hospitality.score==null?'url(#unknown-hatch)':'#75abff'):(metric(item)?'#ff747b':'url(#unknown-hatch)');
  const opacity=item=>layer==='hospitality'?(item.hospitality.score==null ? .55*alpha() : item.hospitality.score/100*alpha()):(metric(item)?Math.min(1,metric(item)/max)*alpha():.55*alpha());
  for(const region of data.regions){
    const outline=svgNode('path',{d:path(region.geometry),fill:level?'transparent':fill(areaData(region)),'fill-opacity':level?0:opacity(areaData(region)),'fill-rule':'evenodd',stroke:'#c7d7eb','stroke-opacity':.25,'stroke-width':level ? .6 : .9,'vector-effect':'non-scaling-stroke',class:'map-region'});
    if(!level){bindArea(outline,region);paintLayer.append(outline);}else{
      const group=svgNode('g',{'clip-path':`url(#clip-${region.id})`});for(const cell of cells.get(`${region.id}:${level}`).filter(c=>c.hasArea)){const r=svgNode('rect',{...rectangle(cell.bounds),fill:fill(cell),'fill-opacity':opacity(cell),stroke:'#c7d7eb','stroke-opacity':.22,'stroke-width':.7,'vector-effect':'non-scaling-stroke',class:'map-subtile'});bindArea(r,region,cell);group.append(r);}outline.setAttribute('pointer-events','none');paintLayer.append(group,outline);
    }paths.set(region.id,outline);
  }
  reconcileAreas();if(focused){const replacement=[...paintLayer.querySelectorAll('[data-region-id]')].find(e=>e.dataset.regionId===focused.regionId&&e.dataset.cellId===focused.cellId);(replacement||svg).focus({preventScroll:true});}
  $('#legend-maximum').textContent=layer==='hospitality'?'100% suitability':`${count(ASSISTANCE_SCALE_MAX)} requests`;$('#legend-title').textContent=layer==='hospitality'?'Hospitality suitability':filter==='all'?'Open assistance requests':`${title(filter)} requests`;$('#legend-ramp').classList.toggle('blue',layer==='hospitality');$('#legend-unknown').textContent=layer==='hospitality'?'Hatched · suitability unknown':filter==='all'?'No reports · coverage unknown':`No ${filter} reports · coverage unknown`;
}
function renderMetrics(){
  const metrics=$('#map-metrics');metrics.replaceChildren();for(const [value,label,tone] of [[data.stats.openRequests,'Open requests',''],[data.stats.coverageChecks,'Coverage checks',''],[data.stats.urgentRequests,'Urgent cases','metric-alert']]){const e=node('div',tone);e.append(node('strong','',count(value)),node('small','',label));metrics.append(e);}$('#coverage-count').textContent=data.stats.coverageChecks;document.querySelector('.operations-heading p').textContent=`${data.regions.length} coverage areas · Houston city limits`;
}
function updateFilterSummary(){
  const need=$('#need-filter'),enabled=document.querySelectorAll('input[name=poi]:checked').length;
  const parts=layer==='assistance'?[need.value==='all'?'All needs':need.selectedOptions[0].textContent+' requests']:[];
  parts.push(enabled===3?'All places':enabled===0?'No places':`${enabled} place ${enabled===1?'type':'types'}`);
  if($('#houston-scenario').value==='empty')parts.push('Coverage exercise');
  $('#map-filter-summary').textContent=parts.join(' · ');
  $('#map-filters').dataset.active=String((layer==='assistance'&&need.value!=='all')||enabled!==3||$('#houston-scenario').value!=='normal');
}
function renderQueue({preservePosition=false}={}){
  if(!data)return;
  const term=$('#map-search').value.trim(),searching=Boolean(term);
  $('#map-search-clear').hidden=!searching;
  const enabled=[...document.querySelectorAll('input[name=poi]:checked')].map(e=>e.value);
  const found=searching?searchMapRecords(data.regions,pois,term,{enabledTypes:enabled}):null;
  const rows=searching?found.regions:queue==='places'?[]:data.regions.filter(r=>
    queue==='coverage'?!r.openCount:layer==='hospitality'?parentHospitality(r).score!=null:r.openCount>0&&metric(r)>0);
  if(!searching)rows.sort((a,b)=>layer==='hospitality'?(parentHospitality(b).score||0)-(parentHospitality(a).score||0):
    NEED_TYPES.indexOf(a.priority)-NEED_TYPES.indexOf(b.priority)||b.openCount-a.openCount);
  const places=searching?found.places:queue==='places'?pois.filter(p=>enabled.includes(p.type)):[];
  const references=searching&&referenceLayer?referenceLayer.search(term):[];
  const list=$('#map-area-list'),panel=$('#operations-panel');
  const focusedKey=list.contains(document.activeElement)?document.activeElement.dataset.queueKey:null;
  const previousScroll={list:list.scrollTop,panel:panel.scrollTop};list.replaceChildren();
  let resultStatus=$('#map-search-results');
  if(!resultStatus){resultStatus=node('div','map-search-results');resultStatus.id='map-search-results';resultStatus.setAttribute('role','status');resultStatus.setAttribute('aria-live','polite');list.before(resultStatus);}
  resultStatus.hidden=!searching;
  resultStatus.textContent=`${count(rows.length+places.length+references.length)} ${rows.length+places.length+references.length===1?'result':'results'} across Houston`;
  list.setAttribute('aria-label',searching?'Map search results':queue==='priority'?'Priority areas':queue==='coverage'?'Coverage checks':'Places');
  for(const r of rows){
    const b=button('',()=>selectArea(r),'area-row'),mark=node('span',`area-icon ${!r.openCount?'unknown':layer==='hospitality'?'blue':''}`);
    b.dataset.queueKey='region:'+r.id;if(searching)b.dataset.searchResult='true';
    mark.append(icon(layer==='hospitality'?'shelter':r.priority==='medical'?'medical':r.priority==='evacuation'?'pin':'supplies'));
    const copy=node('span','area-copy');
    copy.append(node('strong','',r.name),node('small','',layer==='hospitality'?'Demo suitability · needs inspection':r.openCount?`${title(r.priority)} · human review`:'No reports · coverage unknown'));
    b.append(mark,copy,node('span','area-count',layer==='hospitality'?`${parentHospitality(r).score??'—'}%`:count(metric(r))),icon('chevron'));list.append(b);
  }
  if(places.length&&rows.length)list.append(node('div','places-divider','Facilities · fictional'));
  for(const poi of places){
    const b=button('',()=>showPoi(poi),'area-row place-row');
    b.dataset.queueKey='facility:'+poi.id;if(searching)b.dataset.searchResult='true';
    const mark=node('span','area-icon '+(poi.type==='medical'?'':'blue'));mark.append(icon(poi.type));
    const copy=node('span','area-copy');copy.append(node('strong','',poi.name),node('small','',`${poi.region.name} · planning only`));b.append(mark,copy,icon('chevron'));list.append(b);
  }
  if(references.length){
    list.append(node('div','places-divider','Streets & landmarks · geographic context'));
    for(const reference of references.slice(0,24)){
      const b=button('',()=>showReference(reference),'area-row reference-row');b.dataset.searchResult='true';b.dataset.queueKey='reference:'+reference.referenceType+':'+reference.id;
      const mark=node('span','area-icon unknown');mark.append(icon(reference.referenceType==='street'?'map':'pin'));
      const copy=node('span','area-copy');copy.append(node('strong','',reference.name),node('small','',reference.referenceType==='street'?'Street · map reference':title(reference.kind)+' · map reference'));b.append(mark,copy,icon('chevron'));list.append(b);
    }
    if(references.length>24)list.append(node('p','workspace-note',`24 of ${count(references.length)} map references shown. Refine the search to narrow this list.`));
  }
  if(!rows.length&&!places.length&&!references.length)list.append(node('p','record-empty',searching?'No matching areas or facilities. Try another name or resource.':queue==='places'?'No facilities match the enabled categories.':'No areas in this list. Coverage checks remain available.'));
  if(!searching&&queue==='priority'&&layer==='assistance'&&data.unlocatedRequests.length){const b=button('',showUnlocated,'area-row'),copy=node('span','area-copy');copy.append(node('strong','','Location needs review'),node('small','','Retained outside map totals'));b.dataset.queueKey='unlocated';b.append(copy,node('span','area-count',count(data.unlocatedRequests.length)),icon('chevron'));list.append(b);}
  if(focusedKey&&!frame.hidden){
    const replacement=[...list.querySelectorAll('[data-queue-key]')].find(row=>row.dataset.queueKey===focusedKey);
    (replacement||$('#map-search')).focus({preventScroll:true});
  }
  if(preservePosition){list.scrollTop=previousScroll.list;panel.scrollTop=previousScroll.panel;}
}
function showReference(reference){
  if(!svg||!referenceLayer)return;
  closeDetail();focusBounds(referenceLayer.bounds(reference));revealDetail();
  const heading=node('div','detail-heading'),copy=node('div');copy.append(node('div','micro-label',reference.referenceType==='street'?'Street · geographic context':title(reference.kind)+' · geographic context'),node('h2','',reference.name));heading.append(copy,iconButton('close','Close map reference',dismissDetail));
  detail.replaceChildren(heading,node('p','detail-source','City of Houston / USGS geographic reference. Access and operating status have not been assessed.'),node('span','pill','Map context'),node('p','detail-source','The red assistance and blue hospitality overlays remain separate fictional planning data.'));detail.focus({preventScroll:true});if(svg)setCamera(camera,cameraFitted);
}
function showUnlocated(){if(!svg||!data)return;closeDetail();revealDetail();const h=node('div','detail-heading');h.append(node('h2','','Location needs review'),iconButton('close','Close location review',dismissDetail));detail.replaceChildren(h,node('p','detail-source','These requests remain open. They cannot be placed on the map until a location is established.'));if(data.fixturePlacement?.reason)detail.append(node('p','detail-source',data.fixturePlacement.reason));for(const r of data.unlocatedRequests)detail.append(node('p','record-empty',`${r.id}: ${r.summary}`));detail.focus({preventScroll:true});if(svg)setCamera(camera,cameraFitted);}
function showPoi(poi){
  if(!svg||!poi)return;
  closeDetail();activePoiId=poi.id;for(const p of poiLayer.children)p.classList.toggle('is-selected',p.dataset.poiId===poi.id);revealDetail();const header=node('div','detail-heading'),copy=node('div');copy.append(node('div','micro-label',`${title(poi.type)} / FICTIONAL FACILITY`),node('h2','',poi.name));header.append(copy,iconButton('close','Close facility details',dismissDetail));detail.replaceChildren(header,node('p','detail-source',`${poi.region.name} · fictional location for this exercise`),node('span','pill blue','Planning only · not operational'));
  const list=node('dl','detail-breakdown');list.append(node('dt','','Resource'),node('dd','',poi.resource),node('dt','','Demo capacity'),node('dd','',poi.capacity),node('dt','','Status'),node('dd','','Not verified'));detail.append(list,node('p','detail-source','This marker is a fictional planning fixture. Availability, capacity, access, and agency approval have not been verified. It is not a direction to travel.'));appendFixtureImagery(detail,[poi]);
  const context=fixtureImageryContext([poi]);if(context)focusBounds(context.bounds,0,{visibleDetail:true});
  detail.focus({preventScroll:true});if(svg)setCamera(camera,cameraFitted);
}
function renderPois(){
  poiLayer.replaceChildren();const enabled=[...document.querySelectorAll('input[name=poi]:checked')].map(e=>e.value);
  for(const poi of pois.filter(p=>enabled.includes(p.type))){
    const [x,y]=project(poi.point),g=svgNode('g',{class:'map-poi',tabindex:0,role:'button','aria-label':`${poi.name}, fictional ${poi.type}, not operational`});g.dataset.x=x;g.dataset.y=y;g.dataset.poiId=poi.id;g.classList.toggle('is-selected',activePoiId===poi.id);
    g.append(svgNode('circle',{r:16,fill:'#151b27',stroke:'#5e718a','stroke-width':1.4}),svgNode('circle',{r:12.5,fill:poi.type==='medical'?'#34212b':'#192c45'}));const symbol=icon(poi.type);for(const [k,v]of Object.entries({x:-7,y:-7,width:14,height:14}))symbol.setAttribute(k,v);symbol.style.color=poi.type==='medical'?'#ff747b':'#75abff';g.append(symbol);
    g.addEventListener('pointerenter',e=>{if(gesture?.moved)return;showTooltip({name:poi.name,openCount:0,categories:{},hospitality:{score:null}},e);tooltip.replaceChildren(node('strong','',poi.name),node('span','',`${title(poi.type)} · fictional planning facility`));});g.addEventListener('pointerleave',()=>{tooltip.hidden=true;});g.addEventListener('focus',e=>{showTooltip({name:poi.name,openCount:0,categories:{},hospitality:{score:null}},e);tooltip.replaceChildren(node('strong','',poi.name),node('span','',`${title(poi.type)} · fictional planning facility`));});g.addEventListener('blur',()=>{tooltip.hidden=true;});
    g.addEventListener('click',e=>{if(!e.detail)showPoi(poi);});g.addEventListener('keydown',e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();showPoi(poi);}});poiLayer.append(g);
  }setCamera(camera,cameraFitted);
}
function initializeMap(){
  observer?.disconnect();referenceLayer?.dispose();detailImagery?.dispose();historicalLayer?.dispose();referenceLayer=null;detailImagery=null;historicalLayer=null;root.replaceChildren();cells=new Map();paths=new Map();level=-1;
  const [west,south,east,north]=data.city.bbox,cos=Math.cos((north+south)/2*Math.PI/180),scale=Math.min(730/((east-west)*cos),570/(north-south)),width=(east-west)*cos*scale,height=(north-south)*scale;
  project=([lon,lat])=>[(800-width)/2+(lon-west)*cos*scale,(630-height)/2+(north-lat)*scale];
  unproject=([x,y])=>[west+(x-(800-width)/2)/(cos*scale),north-(y-(630-height)/2)/scale];
  svg=svgNode('svg',{class:'map-canvas',role:'group',tabindex:0,'aria-label':'Houston interactive response map. Drag to pan; scroll or pinch to zoom. Plus and minus zoom; arrows pan; zero fits Houston. Enter opens a focused area.'});
  const defs=svgNode('defs'),clip=svgNode('clipPath',{id:'city-clip'});clip.append(svgNode('path',{d:path(data.city.boundary),'clip-rule':'evenodd','fill-rule':'evenodd'}));defs.append(clip);
  const pattern=svgNode('pattern',{id:'unknown-hatch',width:7,height:7,patternUnits:'userSpaceOnUse'});pattern.append(svgNode('path',{d:'M-1 1L1-1M0 7L7 0M6 8L8 6',stroke:'#adbacb','stroke-width':.45,opacity:.5}));defs.append(pattern);
  for(const r of data.regions){const regionClip=svgNode('clipPath',{id:`clip-${r.id}`});regionClip.append(svgNode('path',{d:path(r.geometry),'clip-rule':'evenodd','fill-rule':'evenodd'}));defs.append(regionClip);cells.set(`${r.id}:0`,hospitalityForRegion(r,0));const placed=demoLocations(r);for(const l of [1,2])cells.set(`${r.id}:${l}`,buildSubtiles(r,l,placed));}svg.append(defs);
  // Context imagery is not clipped to Houston; only the request/selection overlays are.
  const land=svgNode('g',{'aria-hidden':'true','pointer-events':'none'});
  land.append(svgNode('path',{d:path(data.city.boundary),class:'map-land','fill-rule':'evenodd'}));
  const basemap=data.basemap||{};
  const images=[...(data.contextBasemaps||[]),{...basemap,kind:'detail',title:'Houston aerial detail'}].filter(image=>
    image.available&&typeof image.url==='string'&&/^\/(?!\/)/.test(image.url)&&Array.isArray(image.bbox)&&image.bbox.length===4&&image.bbox.every(Number.isFinite));
  imagery=svgNode('g',{class:'map-imagery',opacity:Number($('#aerial-opacity').value)/100});
  for(const source of images){
    const image=svgNode('image',{...rectangle(source.bbox),href:source.url,preserveAspectRatio:'none',
      class:source.kind==='detail'||source.kind==='metro'?'map-aerial':'map-context'});
    image.dataset.imageryId=source.id||'houston-aerial';
    image.addEventListener('error',()=>{image.remove();$('#imagery-provenance').textContent='One historical image is unavailable. Remaining layers and Houston boundaries stay visible.';});
    imagery.append(image);
  }
  if(images.length){
    imagery.style.display=$('#basemap-select').value==='aerial'?'':'none';
    $('#imagery-provenance').textContent='NASA Blue Marble 2004 context + USGS / USDA historical aerial imagery. Capture dates vary. No live disaster imagery.';
    land.append(imagery);
  }else{
    imagery=null;$('#basemap-select').value='boundaries';
    $('#imagery-provenance').textContent='Historical imagery unavailable. Showing verified Houston boundaries only.';
  }
  detailImagery=createImageryDetailLayer({pyramid:data.imageryPyramid,project,unproject,onStatus:reportImagery,isActive:()=>!frame.hidden&&!document.hidden});
  imagery?.append(detailImagery.element);detailImagery.setEnabled(imageryMode!=='boundaries');
  historicalLayer=createHistoricalLayer({project,unproject,onReady:historicalReady,onStatus:historicalStatus});land.append(historicalLayer.element);
  paintLayer=svgNode('g',{'clip-path':'url(#city-clip)'});poiLayer=svgNode('g',{'aria-label':'Fictional facilities'});svg.append(land,paintLayer,svgNode('path',{d:path(data.city.boundary),fill:'none',stroke:'#b1c5de','stroke-opacity':.45,'stroke-width':1,'vector-effect':'non-scaling-stroke','fill-rule':'evenodd','pointer-events':'none'}));
  const labels=svgNode('g',{'aria-hidden':'true'});for(const [i,r]of data.regions.entries())if(r.labelPoint&&(i<3||i%9===0)){const [x,y]=project(r.labelPoint),t=svgNode('text',{x,y,class:'map-place-name',fill:'#dbe6f6',stroke:'#0d1119','font-size':5,'text-anchor':'middle'});t.dataset.size='9';t.dataset.rank=String(i<3?i+1:100+i);t.textContent=r.name.toUpperCase();labels.append(t);}const [hx,hy]=project([-95.3698,29.7604]),cityLabel=svgNode('text',{x:hx,y:hy,class:'map-place-name',fill:'#e7edf5',stroke:'#0d1119','font-size':10,'font-weight':600,'text-anchor':'middle'});cityLabel.dataset.size='15';cityLabel.dataset.rank='0';cityLabel.textContent='HOUSTON';labels.append(cityLabel);referenceLayer=createReferenceLayer({project,onStatus:referenceStatus,onReady:()=>{if(svg){if($('#map-search').value.trim())renderQueue({preservePosition:true});setCamera(camera,cameraFitted);}}});
  referenceLayer.setVisible({streets:$('#map-streets').checked,landmarks:$('#map-landmarks').checked});svg.append(referenceLayer.element,labels,poiLayer);root.append(svg);referenceLayer.load();historicalLayer.load();
  pois=planningFacilities(data.regions,data.facilities);
  pointers.clear();gesture=null;bindGestures();observer=new ResizeObserver(entries=>{
    const {width,height}=entries[0].contentRect;
    if(!svg||!width||!height||(width===mapSize.width&&height===mapSize.height))return;
    const previousWidth=mapSize.width;
    mapSize={width,height};
    stopAnimation();
    if(renderFrame)cancelAnimationFrame(renderFrame);
    renderFrame=0;pointers.clear();gesture=null;svg.classList.remove('is-panning');
    if(fixtureFitBounds&&!detail.hidden&&detail.getClientRects().length)focusBounds(fixtureFitBounds.bounds,fixtureFitBounds.zoomFloor,{visibleDetail:true});
    else if(cameraFitted)setCamera(cityFitCamera(),true);
    else setCamera(resizeMapCamera(camera,previousWidth,width,minimumCameraZoom()));
  });observer.observe(frame);renderMetrics();renderPois();renderQueue();fitHouston();$('#map-source').textContent=`NASA Blue Marble · USGS / USDA NAIP · historical imagery · Houston-only request tiles`;
}
function bindGestures(){
  let suppressClick=false;const begin=()=>{gesture=startGesture(camera,[...pointers.values()],screenPoint,800/mapSize.width/camera.zoom,minimumCameraZoom());};
  svg.addEventListener('pointerdown',e=>{if(e.button!==0)return;stopAnimation();pointers.set(e.pointerId,{x:e.clientX,y:e.clientY,target:e.target.closest('[data-region-id], [data-poi-id]')});begin();svg.setPointerCapture(e.pointerId);});
  svg.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId)||!gesture)return;pointers.set(e.pointerId,{...pointers.get(e.pointerId),x:e.clientX,y:e.clientY});const next=moveGesture(gesture,[...pointers.values()]);if(gesture.moved){fixtureFitBounds=null;tooltip.hidden=true;svg.classList.add('is-panning');if(renderFrame)cancelAnimationFrame(renderFrame);renderFrame=requestAnimationFrame(()=>{setCamera(next);renderFrame=0;});}});
  const end=(e,cancel=false)=>{
    if(!pointers.has(e.pointerId))return;const target=!cancel&&!gesture?.moved&&pointers.size===1?pointers.get(e.pointerId).target:null;
    if(renderFrame){cancelAnimationFrame(renderFrame);renderFrame=0;setCamera(moveGesture(gesture,[...pointers.values()]));}suppressClick=true;pointers.delete(e.pointerId);if(svg.hasPointerCapture(e.pointerId))svg.releasePointerCapture(e.pointerId);svg.classList.remove('is-panning');if(pointers.size){begin();gesture.moved=true;}else gesture=null;
    if(target?.dataset.poiId)showPoi(pois.find(p=>p.id===target.dataset.poiId));else if(target?.dataset.regionId){const region=data.regions.find(r=>r.id===target.dataset.regionId),cell=target.dataset.cellId?[...(cells.get(`${region.id}:1`)||[]),...(cells.get(`${region.id}:2`)||[])].find(c=>c.id===target.dataset.cellId):null;selectArea(region,cell);}
  };
  svg.addEventListener('pointerup',e=>end(e));svg.addEventListener('pointercancel',e=>end(e,true));svg.addEventListener('lostpointercapture',e=>{if(pointers.has(e.pointerId))end(e,true);});svg.addEventListener('click',e=>{if(suppressClick&&e.detail){e.stopPropagation();e.preventDefault();suppressClick=false;}},true);
  svg.addEventListener('wheel',e=>{e.preventDefault();fixtureFitBounds=null;stopAnimation();tooltip.hidden=true;setCamera(zoomAt(camera,Math.exp(-Math.max(-140,Math.min(140,e.deltaY))*.0035),screenPoint(e.clientX,e.clientY)));},{passive:false});svg.addEventListener('dblclick',e=>{if(e.target===svg){e.preventDefault();fixtureFitBounds=null;setCamera(zoomAt(camera,1.8,screenPoint(e.clientX,e.clientY)));}});
  svg.addEventListener('keydown',e=>{if(!allowsMapShortcut(e))return;stopAnimation();let next;if(['+','='].includes(e.key))next=zoomAt(camera,1.5);if(e.key==='-')next=zoomAt(camera,1/1.5);const d=60*800/mapSize.width/camera.zoom;if(e.key==='ArrowLeft')next={...camera,x:camera.x-d};if(e.key==='ArrowRight')next={...camera,x:camera.x+d};if(e.key==='ArrowUp')next={...camera,y:camera.y-d};if(e.key==='ArrowDown')next={...camera,y:camera.y+d};if(e.key==='0'||e.key==='Escape'){e.preventDefault();fitHouston(true);return;}if(next){e.preventDefault();fixtureFitBounds=null;setCamera(next);}});
}
function clearScenario(message){
  stopAnimation();observer?.disconnect();
  if(renderFrame)cancelAnimationFrame(renderFrame);
  renderFrame=0;pointers.clear();gesture=null;closeDetail();tooltip.hidden=true;
  referenceLayer?.dispose();detailImagery?.dispose();historicalLayer?.dispose();referenceLayer=null;detailImagery=null;historicalLayer=null;
  data=null;svg=null;paintLayer=null;poiLayer=null;imagery=null;pois=[];
  root.replaceChildren();
  $('#map-area-list').replaceChildren(node('p','record-empty',message));
  const results=$('#map-search-results');if(results)results.hidden=true;
  $('#map-metrics').replaceChildren();$('#coverage-count').textContent='—';
  $('#legend-maximum').textContent='—';$('#map-resolution .area-resolution').textContent=message;$('#map-resolution .aerial-resolution').textContent='';observationView.update({mode:'boundaries'});
  document.querySelector('.operations-heading p').textContent=message;
  $('#map-zoom-in').disabled=true;$('#map-zoom-out').disabled=true;$('#map-fit').disabled=true;$('#show-flooding').disabled=true;
}
async function load(){
  const id=++loadId;clearScenario('Loading Houston…');status.hidden=false;status.textContent='Loading Houston…';
  try{const response=await fetch(`/api/houston?scenario=${encodeURIComponent($('#houston-scenario').value)}`),next=await response.json();if(id!==loadId)return;if(!response.ok||!next.available)throw new Error(next.reason||next.error||'Houston data is unavailable.');data=next;initializeMap();$('#map-fit').disabled=false;status.hidden=true;}catch(e){if(id!==loadId)return;clearScenario('Map unavailable.');status.replaceChildren(node('span','',e.message),button('Try again',load));}
}
$('#map-filters').addEventListener('change',updateFilterSummary);updateFilterSummary();
for(const mode of ['assistance','hospitality'])$('#layer-'+mode).addEventListener('click',()=>{layer=mode;for(const m of ['assistance','hospitality'])$('#layer-'+m).setAttribute('aria-pressed',String(m===mode));$('#need-filter').hidden=mode==='hospitality';updateFilterSummary();$('#layer-description').textContent=mode==='hospitality'?'Bluer · higher demo suitability':'Redder · more open requests';if(svg){renderTiles();renderQueue();if(selected)renderAreaDetail(selected.region,selected.cell);}});
$('#need-filter').addEventListener('change',e=>{filter=e.target.value;if(svg){renderTiles();renderQueue();if(selected)renderAreaDetail(selected.region,selected.cell);}});
for(const type of ['priority','coverage','places'])$('#queue-'+type).addEventListener('click',()=>{$('#map-search').value='';queue=type;for(const q of ['priority','coverage','places']){$('#queue-'+q).setAttribute('aria-selected',String(q===type));$('#queue-'+q).tabIndex=q===type?0:-1;}$('#map-area-list').setAttribute('aria-label',type==='priority'?'Priority areas':type==='coverage'?'Coverage checks':'Places');renderQueue();});
$('#map-search').addEventListener('input',renderQueue);$('#houston-scenario').addEventListener('change',load);$('#map-zoom-in').addEventListener('click',()=>{if(svg)animateCamera(zoomAt(camera,1.6));});$('#map-zoom-out').addEventListener('click',()=>{if(svg)animateCamera(zoomAt(camera,1/1.6));});$('#map-fit').addEventListener('click',()=>fitHouston(true));$('#city-fit').addEventListener('click',()=>{location.hash='mayor';fitHouston(true);});
for(const input of document.querySelectorAll('input[name=poi]'))input.addEventListener('change',()=>{if(svg){renderPois();renderQueue();}});
$('#imagery-toggle').addEventListener('click',()=>{const panel=$('#imagery-panel');panel.hidden=!panel.hidden;$('#imagery-toggle').setAttribute('aria-expanded',String(!panel.hidden));if(mobile()&&!panel.hidden){frame.classList.remove('panel-open');$('#mobile-panel-toggle').setAttribute('aria-expanded','false');}});document.addEventListener('keydown',e=>{if(!allowsMapShortcut(e)||e.key!=='Escape'||frame.hidden)return;const imageryWasOpen=!$('#imagery-panel').hidden,overviewWasOpen=frame.classList.contains('panel-open'),focus=document.activeElement;$('#imagery-panel').hidden=true;$('#imagery-toggle').setAttribute('aria-expanded','false');frame.classList.remove('panel-open');$('#mobile-panel-toggle').setAttribute('aria-expanded','false');if(imageryWasOpen&&$('#imagery-panel').contains(focus))$('#imagery-toggle').focus({preventScroll:true});else if(overviewWasOpen&&$('#operations-panel').contains(focus))$('#mobile-panel-toggle').focus({preventScroll:true});else if(detail.contains(focus)){e.preventDefault();dismissDetail();}});
$('#basemap-select').addEventListener('change',e=>{imageryModeTouched=true;applyImageryMode(e.target.value);});$('#aerial-opacity').addEventListener('input',e=>{imageryOpacityTouched=true;setImageryOpacity(e.target.value);if(svg)updateMapResolution();});$('#tile-opacity').addEventListener('input',()=>{overlayOpacityTouched=true;if(svg)renderTiles();});$('#mobile-panel-toggle').addEventListener('click',()=>{if(mobile()){const open=frame.classList.toggle('panel-open');$('#mobile-panel-toggle').setAttribute('aria-expanded',String(open));if(open){$('#imagery-panel').hidden=true;$('#imagery-toggle').setAttribute('aria-expanded','false');}}else{frame.classList.remove('overview-collapsed');$('#mobile-panel-toggle').setAttribute('aria-expanded','true');if(svg)setCamera(cameraFitted?cityFitCamera():camera,cameraFitted);$('#map-search').focus({preventScroll:true});}});
compactMapLayout.addEventListener('change',()=>{
  if(!mobile())return;
  const imageryPanel=$('#imagery-panel');
  if(frame.classList.contains('panel-open')&&!imageryPanel.hidden){
    if($('#operations-panel').contains(document.activeElement))imageryPanel.hidden=true;
    else frame.classList.remove('panel-open');
  }
  $('#mobile-panel-toggle').setAttribute('aria-expanded',String(frame.classList.contains('panel-open')));
  $('#imagery-toggle').setAttribute('aria-expanded',String(!imageryPanel.hidden));
  if(svg)requestAnimationFrame(()=>setCamera(camera,cameraFitted));
});
$('#desktop-panel-close').addEventListener('click',()=>{frame.classList.add('overview-collapsed');$('#mobile-panel-toggle').setAttribute('aria-expanded','false');$('#mobile-panel-toggle').focus();});
$('#map-search').addEventListener('keydown',e=>{if(!allowsMapShortcut(e))return;if(e.key==='Enter'){e.preventDefault();if(e.target.value.trim())$('#map-area-list [data-search-result="true"]')?.click();}if(e.key==='Escape'&&e.target.value){e.preventDefault();e.stopPropagation();e.target.value='';renderQueue();}});
document.addEventListener('keydown',e=>{if(allowsMapShortcut(e)&&e.key==='/'&&!frame.hidden&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName)){e.preventDefault();frame.classList.remove('overview-collapsed');if(mobile()){frame.classList.add('panel-open');$('#mobile-panel-toggle').setAttribute('aria-expanded','true');$('#imagery-panel').hidden=true;$('#imagery-toggle').setAttribute('aria-expanded','false');}$('#map-search').focus();}});
load();

for(const [index,id]of ['priority','coverage','places'].entries())$('#queue-'+id).addEventListener('keydown',e=>{if(!allowsMapShortcut(e))return;if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const ids=['priority','coverage','places'],target=ids[e.key==='Home'?0:e.key==='End'?2:(index+(e.key==='ArrowRight'?1:2))%3];$('#queue-'+target).click();$('#queue-'+target).focus();}});
$('#map-search-clear').addEventListener('click',()=>{$('#map-search').value='';renderQueue();$('#map-search').focus();});

for(const q of ['priority','coverage','places'])$('#queue-'+q).tabIndex=q===queue?0:-1;

for(const id of ['map-streets','map-landmarks'])$('#'+id).addEventListener('change',()=>{referenceLayer?.setVisible({streets:$('#map-streets').checked,landmarks:$('#map-landmarks').checked});if(svg)setCamera(camera,cameraFitted);});
$('#map-reference-retry').addEventListener('click',()=>referenceLayer?.load(true));
$('#imagery-detail-retry').addEventListener('click',()=>{if(isHistorical(imageryMode))historicalLayer?.retry();else detailImagery?.retry();$('#basemap-select').focus({preventScroll:true});});

for(const id of ['imagery-toggle','mobile-panel-toggle','desktop-panel-close'])$('#'+id).addEventListener('click',()=>{if(svg)requestAnimationFrame(()=>setCamera(camera,cameraFitted));});

$('#capture-date').addEventListener('change',e=>{captureDates[imageryMode]=e.target.value;if(['water','event-rgb'].includes(imageryMode)){captureDates.water=e.target.value;captureDates['event-rgb']=e.target.value;}historicalLayer?.setDate(e.target.value);if(svg)setCamera(camera,cameraFitted);});
$('#historical-example').addEventListener('click',()=>focusHistoricalExample(0));
$('#show-flooding').addEventListener('click',()=>{
  const examples=historicalLayer?.hotspots()||[];
  let index=examples.findIndex(asset=>asset.id==='harvey-20170830-barker');
  if(index<0)index=examples.findIndex(asset=>asset.id==='harvey-20170830-baker-road-fine');
  if(index<0)index=examples.length?0:-1;
  if(index<0){$('#show-flooding').disabled=true;return;}
  imageryModeTouched=true;imageryOpacityTouched=true;captureDates.flood=examples[index].date;
  $('#aerial-opacity').value='100';applyImageryMode('flood');focusHistoricalExample(index);
  // Open a real flooded neighborhood, rather than a citywide image dominated by missing coverage.
  if(['harvey-20170830-barker','harvey-20170830-baker-road-fine'].includes(examples[index].id))focusBounds([-95.72,29.74472,-95.69548,29.76780]);
});

$('#history-retry').addEventListener('click',()=>historicalLayer?.load(true));
