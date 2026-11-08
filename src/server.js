import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { InputError, openCase, sendOutreach, receiveReport, verifyCase, setConsent } from './domain.js';
import { Store } from './store.js';
import { SatelliteService } from './satellite.js';
import { HoustonService } from './houston-service.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  '/': ['index.html', 'text/html'],
  '/app.js': ['app.js', 'text/javascript'],
  '/styles.css': ['styles.css', 'text/css'],
  '/houston.js': ['houston.js', 'text/javascript'],
  '/map-model.js': ['map-model.js', 'text/javascript'],
  '/ui.js': ['ui.js', 'text/javascript'],
  '/records.js': ['records.js', 'text/javascript'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/workspace.js': ['workspace.js', 'text/javascript'],
  '/workspace.css': ['workspace.css', 'text/css'],
  '/data/houston-imagery.jpg': ['data/houston-imagery.jpg', 'image/jpeg'],
};
async function body(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new InputError('Use application/json.', 415);
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
export function createApp(store = new Store(resolve(root, '.data/state.json')), satellite = new SatelliteService(root), houston = new HoustonService(root)) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'");
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    try {
      const port = req.socket.localPort;
      const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!allowedHosts.includes(req.headers.host)) throw new InputError('Loopback host required.', 403);
      if (req.headers.origin && !allowedHosts.map((host) => `http://${host}`).includes(req.headers.origin)) throw new InputError('Cross-origin access is disabled.', 403);
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && url.pathname === '/api/state') return json(200, store.read());
      if (req.method === 'GET' && url.pathname === '/api/health') return json(200, { ok: true, mode: 'simulation', liveSendingEnabled: false });
      if (req.method === 'GET' && url.pathname === '/api/houston') {
        if ([...url.searchParams.keys()].some(key => !['scenario', 'city'].includes(key))) throw new InputError('Unsupported dashboard option.');
        return json(200, houston.view({ scenario: url.searchParams.get('scenario') || 'normal', city: url.searchParams.get('city') || 'houston' }));
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
        if (url.pathname === '/api/cases') return json(201, store.act(openCase, input));
        if (url.pathname === '/api/reports') return json(200, store.act(receiveReport, input));
        if (url.pathname === '/api/reset') return json(200, store.reset());
        const caseAction = url.pathname.match(/^\/api\/cases\/(C\d+)\/(outreach|verify)$/);
        if (caseAction) return json(200, store.act(caseAction[2] === 'outreach' ? sendOutreach : verifyCase, caseAction[1], input));
        const consent = url.pathname.match(/^\/api\/participants\/([a-z0-9-]+)\/consent$/);
        if (consent) return json(200, store.act(setConsent, consent[1], input));
      }
      if (req.method === 'GET' && files[url.pathname]) {
        const [filename, type] = files[url.pathname];
        const data = await readFile(resolve(root, 'public', filename));
        res.writeHead(200, { 'Content-Type': type.startsWith('image/') ? type : `${type}; charset=utf-8` }); res.end(data); return;
      }
      return json(404, { error: 'Not found.' });
    } catch (error) {
      if (error instanceof InputError) return json(error.status, { error: error.message });
      console.error('Request failed:', error.message);
      return json(500, { error: 'The demo could not save this action. Existing data was preserved.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer from 1024 to 65535.');
  const app = createApp();
  app.listen(port, '127.0.0.1', () => console.log(`Family Response demo: http://127.0.0.1:${port}\nFictional data only. SMS, model extraction and emergency alert are simulated. No credentials used.`));
}
