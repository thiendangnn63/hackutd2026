export function node(tag, className, text) {
  const el=document.createElement(tag);if(className)el.className=className;if(text!==undefined)el.textContent=String(text);return el;
}
export function button(text, action, className='control') {
  const el=node('button',className,text);el.type='button';if(action)el.addEventListener('click',action);return el;
}
export const svgNode=(tag,attrs={})=>{const el=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,String(value));return el;};
const paths={
 map:'m3 5 6-2 6 2 6-2v16l-6 2-6-2-6 2V5Zm6-2v16m6-14v16',
 messages:'M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-1 1v-9.5A8.5 8.5 0 0 1 11.5 3h1a8.5 8.5 0 0 1 8.5 8.5ZM7 9h10M7 13h7',
 people:'M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-3.87M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-7.87a4 4 0 0 1 0 7.75',
 casework:'M9 4H5a2 2 0 0 0-2 2v14h18V6a2 2 0 0 0-2-2h-4M9 4V2h6v2M8 10h8m-8 5h5',
 layers:'m12 3 10 6-10 6L2 9l10-6Zm-9 11 9 5 9-5m-18 5 9 5 9-5',
 search:'m21 21-4.4-4.4M19 10.5a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0Z',
 plus:'M12 5v14M5 12h14',minus:'M5 12h14',close:'m6 6 12 12M6 18 18 6',
 fit:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M9 12h6m-3-3v6',
 pin:'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Zm-5 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
 arrow:'M5 12h14m-5-5 5 5-5 5',chevron:'m9 5 7 7-7 7',down:'m6 9 6 6 6-6',
 medical:'M9 3h6v6h6v6h-6v6H9v-6H3V9h6V3Z',
 shelter:'m3 11 9-8 9 8v10h-6v-7H9v7H3V11Z',
 supplies:'m12 2 9 5v10l-9 5-9-5V7l9-5Zm0 10 9-5m-9 5L3 7m9 5v10m-5-17 9 5',
 clock:'M12 8v5l3 2m7-3a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
 image:'M3 3h18v18H3V3Zm0 14 6-6 4 4 3-3 5 5M7 7h.01',
 check:'m5 12 4 4L19 6',info:'M12 11v6m0-10h.01M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z',
 reset:'M3 10a9 9 0 1 1 1 7M3 3v7h7',filter:'M3 5h18M6 12h12m-9 7h6'
};
export function icon(name) {const svg=svgNode('svg',{viewBox:'0 0 24 24',fill:'none',stroke:'currentColor','stroke-width':1.65,'stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true'});svg.append(svgNode('path',{d:paths[name]||paths.pin}));return svg;}
export function iconButton(name,label,action,className='icon-button') {const b=button('',action,className);b.setAttribute('aria-label',label);b.title=label;b.append(icon(name));return b;}
export const title=value=>String(value||'unknown').replaceAll('_',' ').replace(/^./,c=>c.toUpperCase());
export const count=value=>Number(value||0).toLocaleString('en-US');
