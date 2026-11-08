import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wait = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

async function unusedPort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'beacon-signal-fixture-'));
  cpSync(join(root, 'src'), join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function interruptWhileDraining(t, dir, script, args, lockPath, readyText) {
  const child = spawn(process.execPath, [script, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH } });
  const exited = new Promise((done, reject) => { child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal })); });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  let output = '';
  child.stdout.on('data', bytes => { output += bytes.toString(); });
  child.stderr.on('data', bytes => { output += bytes.toString(); });
  const deadline = Date.now() + 5000;
  while (!output.includes(readyText) && child.exitCode === null && child.signalCode === null && Date.now() < deadline) await wait(10);
  assert.ok(output.includes(readyText), 'The local fixture launcher became ready.');
  assert.equal(existsSync(lockPath), true);
  child.kill('SIGINT');
  await wait(25); // The injected drain remains pending for 180 ms.
  child.kill('SIGINT');
  await wait(25);
  child.kill('SIGTERM');
  let timeout;
  const result = await Promise.race([exited, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Launcher did not finish its bounded shutdown.')), 5000); })]).finally(() => clearTimeout(timeout));
  assert.deepEqual(result, { code: 0, signal: null });
  assert.equal(existsSync(join(dir, 'drained.marker')), true);
  assert.equal(existsSync(lockPath), false);
  assert.equal(existsSync(join(dir, 'network.marker')), false);
}

test('rehearsal CLI drains once and releases its lock after repeated interrupt/termination signals', async t => {
  const dir = fixture(t), port = await unusedPort(), path = join(dir, 'src/rehearsal.js');
  let source = readFileSync(path, 'utf8');
  source = source.replace('export function createRehearsalRuntime(', 'function createOriginalRehearsalRuntime(');
  // Simulate a pending bounded operation without changing the actual launcher's
  // signal handlers or constructing a provider. Its real Store/journal bootstrap
  // and lock release still run.
  source += `\nimport {writeFileSync as signalWrite} from 'node:fs';
globalThis.fetch=()=>{signalWrite('network.marker','unexpected');throw new Error('No provider calls.');};
export function createRehearsalRuntime(options){
 const runtime=createOriginalRehearsalRuntime(options);let stopped;
 return {...runtime,shutdown(){return stopped??=new Promise(done=>setTimeout(done,180)).then(()=>runtime.shutdown()).then(()=>signalWrite('drained.marker','done'));}};
}\n`;
  writeFileSync(path, source);
  await interruptWhileDraining(t, dir, 'src/rehearsal-server.js', ['--port', String(port)], join(dir, '.data/rehearsal/server.lock'), 'Beacon rehearsal:');
});

test('phone CLI signal handling drains a fixture session without reading credentials or constructing providers', async t => {
  const dir = fixture(t), port = await unusedPort(), path = join(dir, 'src/phone-server.js');
  let source = readFileSync(path, 'utf8');
  source = source.replace('export function preparePhoneServer(', 'function prepareOriginalPhoneServer(');
  // Replace only private bootstrap with a credential-free delayed session. The
  // CLI's actual main(), shared shutdown, signals and HTTP close execute intact.
  source += `\nimport {createServer as signalServer} from 'node:http';
globalThis.fetch=()=>{writeFileSync('network.marker','unexpected');throw new Error('No provider calls.');};
export function preparePhoneServer(){
 mkdirSync('.data',{recursive:true});writeFileSync('.data/fixture.phone.lock','fixture');let stopped;
 const phone={shutdown(){return stopped??=new Promise(done=>setTimeout(done,180)).then(()=>writeFileSync('drained.marker','done'));}};
 return {app:signalServer((req,res)=>res.end('fixture')),phone,port:${port},release:async()=>{await phone.shutdown();unlinkSync('.data/fixture.phone.lock');}};
}\n`;
  writeFileSync(path, source);
  await interruptWhileDraining(t, dir, 'src/phone-server.js', ['--config', join(dir, 'unused-fixture.json')], join(dir, '.data/fixture.phone.lock'), 'Beacon phone test:');
});
