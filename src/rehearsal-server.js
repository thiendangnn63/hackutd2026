// A zero-credential, loopback-only presentation launcher. Local rehearsal files
// are separate from the saved family exercise and the real provider journal.
import {readFileSync,mkdirSync,openSync,writeFileSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {ProviderLedger} from './provider-ledger.js';
import {createApp} from './server.js';
import {createRehearsalRuntime} from './rehearsal.js';
import {shutdownPhoneServer} from './phone-server.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
function lock(path){
  const token=randomUUID();let fd;
  try{mkdirSync(dirname(path),{recursive:true,mode:0o700});fd=openSync(path,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,token}));}
  catch{if(fd!==undefined)try{closeSync(fd);}catch{}throw new Error('A rehearsal already holds its data lock. Stop that process before starting another.');}
  let released=false;return()=>{if(released)return;released=true;try{closeSync(fd);}catch{}try{if(JSON.parse(readFileSync(path,'utf8')).token===token)unlinkSync(path);}catch{}};
}
export function prepareRehearsalServer({rootDir=root,port=4173,StoreImpl=Store,LedgerImpl=ProviderLedger,appFactory=createApp}={}){
  if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Use a local port from 1024 to 65535.');
  const data=resolve(rootDir,'.data/rehearsal'),release=lock(resolve(data,'server.lock'));
  try{
    const store=new StoreImpl(resolve(data,'state.json')),ledger=new LedgerImpl(resolve(data,'transport.json'));
    const phone=createRehearsalRuntime({store,ledger}),app=appFactory(store,undefined,undefined,{phone});
    let cleanup;
    const close=()=>cleanup??=phone.shutdown().then(release);app.once?.('close',()=>{void close();});
    return {app,phone,store,port,release:close};
  }catch(error){release();throw error;}
}
async function main(){
  let session;
  try{
    const args=process.argv.slice(2);
    if(args.length&&!(args.length===2&&args[0]==='--port'))throw new Error('Use npm run demo, optionally followed by -- --port 4178.');
    const port=Number(args.length?args[1]:process.env.PORT||4173);
    session=prepareRehearsalServer({port});
    await new Promise((done,reject)=>{session.app.once('error',reject);session.app.listen(port,'127.0.0.1',done);});
    console.log(`Beacon rehearsal: http://127.0.0.1:${port}/#mayor\nFictional phone, local scripted interpretation, no provider calls or spend.\nOpen Casework to rehearse a report; Reset exercise starts a fresh rehearsal.`);
    const close=()=>{void shutdownPhoneServer(session);};process.once('SIGINT',close);process.once('SIGTERM',close);
  }catch(error){await session?.release();console.error(error.code==='EADDRINUSE'?'Stop the other Beacon server on this port before starting the rehearsal.':error.message);process.exitCode=1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
