import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { InputError, openCase, sendOutreach, receiveReport, verifyCase, setConsent } from './domain.js';
import { Store } from './store.js';
import { SatelliteService } from './satellite.js';
import { HoustonService } from './houston-service.js';
import {historicalImagery,historicalImageFile} from './historical-imagery.js';
import { publicState } from './public-state.js';
import { InboxError, acceptReportProposal, dismissReportProposal } from './report-inbox.js';
import { PhoneRuntimeError } from './phone-runtime.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/styles.css': ['styles.css', 'text/css'],
  '/houston.js': ['houston.js', 'text/javascript'],
  '/map-model.js': ['map-model.js', 'text/javascript'],
  '/imagery-model.js': ['imagery-model.js', 'text/javascript'],
  '/imagery-layer.js': ['imagery-layer.js', 'text/javascript'],
  '/labels-model.js': ['labels-model.js', 'text/javascript'],
  '/reference-layer.js': ['reference-layer.js', 'text/javascript'],
  '/historical-layer.js': ['historical-layer.js', 'text/javascript'],
  '/map-coverage.js': ['map-coverage.js', 'text/javascript'],
  '/observation-view.js': ['observation-view.js', 'text/javascript'],
  '/data/houston-observation-coverage.json': ['data/houston-observation-coverage.json', 'application/json'],
  '/ui.js': ['ui.js', 'text/javascript'],
  '/records.js': ['records.js', 'text/javascript'],
  '/state-client.js': ['state-client.js', 'text/javascript'],
  '/proposal-view.js': ['proposal-view.js', 'text/javascript'],
  '/form-drafts.js': ['form-drafts.js', 'text/javascript'],
  '/phone-view.js': ['phone-view.js', 'text/javascript'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/beacon-logo.svg': ['beacon-logo.svg', 'image/svg+xml'],
  '/workspace.js': ['workspace.js', 'text/javascript'],
  '/archive-view.js': ['archive-view.js', 'text/javascript'],
  '/record-focus.js': ['record-focus.js', 'text/javascript'],
  '/workspace.css': ['workspace.css', 'text/css'],
  '/data/houston-imagery.jpg': ['data/houston-imagery.jpg', 'image/jpeg'],
  '/data/houston-streets.json': ['data/houston-streets.json', 'application/json'],
  '/data/houston-landmarks.json': ['data/houston-landmarks.json', 'application/json'],
  '/data/houston-labels-meta.json': ['data/houston-labels-meta.json', 'application/json'],
  '/data/earth-context.jpg': ['data/earth-context.jpg', 'image/jpeg'],
  '/data/houston-context.jpg': ['data/houston-context.jpg', 'image/jpeg'],
  '/data/houston-metro.png': ['data/houston-metro.png', 'image/png'],
};
async function body(req) {
  if (!/^application\/json(?:\s*;[^\r\n]*)?$/i.test(String(req.headers['content-type'] || ''))) throw new InputError('Use application/json.', 415);
  let bytes = 0, data = '';
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 16_384) throw new InputError('Request too large.', 413);
    data += chunk.toString('utf8');
  }
  try {
    const value = JSON.parse(data || '{}');
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch { throw new InputError('Expected a JSON object.'); }
}
// A slow reader retains only the latest pending snapshot. The frame that made
// write() return false is already buffered and must not be sent again on drain.
export function openStateStream(res, store, { heartbeatMs = 15_000, backpressureMs = 30_000 } = {}) {
  let closed = false, blocked = false, pending = null, heartbeat, pressureTimer;
  let unsubscribe = () => {};
  const cleanup = () => {
    if (closed) return;
    closed = true; pending = null; unsubscribe();
    clearInterval(heartbeat); clearTimeout(pressureTimer);
    res.off('close', cleanup); res.off('error', close); res.off('drain', drain);
  };
  const close = () => { cleanup(); if (!res.destroyed) res.destroy(); };
  const write = frame => {
    try {
      if (!res.write(frame)) {
        blocked = true;
        pressureTimer = setTimeout(close, backpressureMs); pressureTimer.unref?.();
      }
    } catch { close(); }
  };
  const send = snapshot => {
    if (closed) return;
    if (blocked) { pending = snapshot; return; }
    try { write(`id: ${snapshot.sessionId}:${snapshot.revision}\ndata: ${JSON.stringify({ ...snapshot, state: publicState(snapshot.state) })}\n\n`); }
    catch { close(); }
  };
  const drain = () => {
    if (closed) return;
    blocked = false; clearTimeout(pressureTimer);
    const latest = pending; pending = null;
    if (latest) send(latest);
  };
  res.on('close', cleanup); res.on('error', close); res.on('drain', drain);
  // No asynchronous boundary occurs between subscription and initial read.
  unsubscribe = store.onChange(send);
  const snapshot = store.readVersioned();
  try {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8', 'Connection': 'keep-alive',
      'X-Beacon-Session': snapshot.sessionId, 'X-Beacon-Revision': String(snapshot.revision),
    });
    res.flushHeaders?.(); send(snapshot);
  } catch { close(); }
  if (!closed) {
    heartbeat = setInterval(() => { if (!closed && !blocked) write(': heartbeat\n\n'); }, heartbeatMs);
    heartbeat.unref?.();
  }
  return cleanup;
}

export function createApp(store = new Store(resolve(root, '.data/state.json')), satellite = new SatelliteService(root), houston = new HoustonService(root), {phone = null} = {}) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    const stateJson = (status, data) => {
      const version = store.version;
      res.setHeader('X-Beacon-Session', version.sessionId);
      res.setHeader('X-Beacon-Revision', String(version.revision));
      return json(status, publicState(data));
    };
    try {
      const port = req.socket.localPort;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) throw new InputError('Loopback host required.', 403);
      if (req.headers.origin && !allowedHosts.map((host) => `http://${host}`).includes(req.headers.origin)) throw new InputError('Cross-origin access is disabled.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/state') return stateJson(200, store.read());
      if (req.method === 'GET' && url.pathname === '/api/events') {
        if (url.search) throw new InputError('Unsupported state stream option.');
        openStateStream(res, store); return;
      }
      const phoneStatus = () => phone ? phone.status() : {enabled:false,phoneConfigured:false,modelConfigured:false,listening:false,sendingEnabled:false,mode:'offline',endsAt:null,modelUsed:0,modelLimit:3,replyText:null,eligibleReportIds:[],replyStates:[]};
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, mode: 'simulation', liveSendingEnabled: Boolean(phoneStatus().sendingEnabled) });
      if (req.method === 'GET' && url.pathname === '/api/phone/status') {
        if(url.search)throw new InputError('Unsupported phone status option.');
        return json(200,phoneStatus());
      }
      if (req.method === 'GET' && url.pathname === '/api/houston/imagery') {
        if(url.search)throw new InputError('Unsupported imagery option.');
        return json(200,houston.imageryPyramid());
      }
      if (req.method === 'GET' && url.pathname.startsWith('/data/imagery/')) {
        const bytes=houston.imageryTile(url.pathname.slice('/data/imagery/'.length));
        res.writeHead(200,{'Content-Type':'image/webp'});res.end(bytes);return;
      }
      if (req.method === 'GET' && url.pathname === '/api/houston') {
        if ([...url.searchParams.keys()].some(key => !['scenario', 'city'].includes(key))) throw new InputError('Unsupported dashboard option.');
        return json(200, houston.view({ scenario: url.searchParams.get('scenario') || 'normal', city: url.searchParams.get('city') || 'houston' }));
      }
      if(req.method==='GET'&&url.pathname==='/api/houston/history'){
        if(url.search)throw new InputError('Unsupported historical imagery option.');
        return json(200,historicalImagery(root));
      }
      if(req.method==='GET'&&/^\/data\/(water|flood-imagery)\//.test(url.pathname)){
        const file=historicalImageFile(root,url.pathname),bytes=await readFile(file.path);
        res.writeHead(200,{'Content-Type':file.contentType});res.end(bytes);return;
      }
      if (req.method === 'GET' && url.pathname === '/api/satellite') return json(200, satellite.status());
      if (req.method === 'GET' && url.pathname.startsWith('/api/satellite/images/')) {
        const data = satellite.image(url.pathname.slice('/api/satellite/images/'.length));
        res.writeHead(200, { 'Content-Type':'image/png' }); res.end(data); return;
      }
      if (req.method === 'POST') {
        if (!req.headers.origin) throw new InputError('Same-origin requests are required for mutations.', 403);
        const input = await body(req);
        if (url.pathname === '/api/satellite/infer') return json(200, await satellite.infer(input));
        const phoneAction = url.pathname.match(/^\/api\/phone\/(listen|stop|poll)$/);
        const reportPhoneAction = url.pathname.match(/^\/api\/reports\/(R-[a-zA-Z0-9-]+)\/(interpret|reply\/(prepare|send|delivery))$/);
        if (phoneAction || reportPhoneAction) {
          if(url.search)throw new InputError('Unsupported phone action option.');
          if (!phone) throw new InputError('The phone and model test is not configured.',409);
          const action = phoneAction?.[1] || reportPhoneAction[3] || reportPhoneAction[2];
          if(Object.keys(input).some(key=>action!=='send'||key!=='manualRetry') || (input.manualRetry!==undefined&&typeof input.manualRetry!=='boolean')) throw new InputError('Unsupported phone action input.');
          const reportId = reportPhoneAction?.[1];
          let result;
          if(action==='listen')result=await phone.startListening();
          else if(action==='stop')result=await phone.stopListening();
          else if(action==='poll')result=await phone.pollOnce();
          else if(action==='interpret')result=await phone.interpretOne(reportId);
          else if(action==='prepare')result=await phone.prepareReply(reportId);
          else if(action==='send')result=await phone.sendReply(reportId,{manualRetry:input.manualRetry===true});
          else if(action==='delivery')result=await phone.checkDelivery(reportId);
          return stateJson(200,{...store.read(),phone:phoneStatus(),phoneAction:result});
        }
        if (url.pathname === '/api/cases') return stateJson(201, store.act(openCase, input));
        if (url.pathname === '/api/reports') return stateJson(200, store.act(receiveReport, input));
        const review = url.pathname.match(/^\/api\/reports\/(R-[a-zA-Z0-9-]+)\/review$/);
        if (review) {
          if(url.search)throw new InputError('Unsupported proposal review option.');
          if (Object.keys(input).some(key => !['action','reviewerName','note','expectedProposalToken','observationIndices'].includes(key)) || !['accept','dismiss'].includes(input.action)) throw new InputError('Choose accept or dismiss for this proposal.');
          const { action, ...decision } = input;
          return stateJson(200, store.act(action === 'accept' ? acceptReportProposal : dismissReportProposal, { ...decision, reportId: review[1] }));
        }
        if (url.pathname === '/api/reset') return stateJson(200, store.reset());
        const caseAction = url.pathname.match(/^\/api\/cases\/(C\d+)\/(outreach|verify)$/);
        if (caseAction) return stateJson(200, store.act(caseAction[2] === 'outreach' ? sendOutreach : verifyCase, caseAction[1], input));
        const consent = url.pathname.match(/^\/api\/participants\/([a-z0-9-]+)\/consent$/);
        if (consent) return stateJson(200, store.act(setConsent, consent[1], input));
      }
      if (req.method === 'GET' && files[url.pathname]) {
        const [filename, type] = files[url.pathname];
        const data = await readFile(resolve(root, 'public', filename));
        res.writeHead(200, { 'Content-Type': type.startsWith('image/') ? type : `${type}; charset=utf-8` }); res.end(data); return;
      }
      return json(404, { error: 'Not found.' });
    } catch (error) {
      if (error instanceof InputError || error instanceof InboxError || error instanceof PhoneRuntimeError) return json(error.status, { error: error.message });
      console.error('Request failed:', error.message);
      return json(500, { error: 'The demo could not save this action. Existing data was preserved.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
  const app = createApp();
  app.listen(port, '127.0.0.1', () => console.log(`Beacon demo: http://127.0.0.1:${port}\nFictional data only. SMS, model extraction and emergency alert are simulated. No credentials used.`));
}
