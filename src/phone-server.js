// Explicit opt-in launcher. Importing this module reads no environment keys,
// opens no listener and constructs no providers.
import {readFileSync,lstatSync,mkdirSync,openSync,writeFileSync,closeSync,unlinkSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {Store} from './store.js';
import {ProviderLedger} from './provider-ledger.js';
import {createPhotonClient} from './photon-client.js';
import {createNemotronClient} from './nemotron-client.js';
import {bindPhotonIdentity,photonScopeFingerprint} from './photon-inbox.js';
import {createPhoneRuntime,PhoneRuntimeError} from './phone-runtime.js';
import {createApp} from './server.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const fail=()=>{throw new PhoneRuntimeError('configuration');};
const bounded=(value,max)=>Number.isInteger(value)&&value>=1&&value<=max;
export function validatePhoneConfig(value,state){
  try{
    if(!value||value.approved!==true||!Array.isArray(value.identities)||value.identities.length!==1||!bounded(value.maxModelRequests,3))fail();
    photonScopeFingerprint(value.scope);
    if(value.scope.platform!=='imessage')fail();
    const identities=value.identities.map(input=>bindPhotonIdentity(state,input)),identity=identities[0],approval=value.replyApproval;
    if(identity.projectId!==value.scope.projectId||identity.platform!==value.scope.platform||identity.agentUsrId!==value.scope.agentUsrId||identity.caseId===null||!identity.approvedTextHashes.length||!approval||['personUsrId','spaceId','fixtureAlias','caseId'].some(key=>approval[key]!==identity[key])||typeof approval.text!=='string'||!approval.text.trim()||approval.text.length>1000||!bounded(approval.maxSendRequests,2)||!bounded(approval.maxDeliveryChecks,4))fail();
    return structuredClone({scope:value.scope,identities,replyApproval:approval,maxModelRequests:value.maxModelRequests});
  }catch{fail();}
}
export function parsePhoneArgs(args){
  if(!Array.isArray(args)||args.length!==2||args[0]!=='--config'||typeof args[1]!=='string'||!args[1].trim())fail();
  return {configPath:resolve(args[1])};
}
function acquireLock(statePath){
  const path=statePath+'.phone.lock',token=randomUUID();let fd;
  try{mkdirSync(dirname(path),{recursive:true,mode:0o700});fd=openSync(path,'wx',0o600);writeFileSync(fd,JSON.stringify({pid:process.pid,token,startedAt:new Date().toISOString()}));}
  catch{try{if(fd!==undefined)closeSync(fd);}catch{}throw new PhoneRuntimeError('server_in_use');}
  let released=false;return ()=>{if(released)return;released=true;try{closeSync(fd);}catch{}try{const current=JSON.parse(readFileSync(path,'utf8'));if(current.token===token)unlinkSync(path);}catch{}};
}

// Dependency injection permits a complete $0 bootstrap test. This constructs the
// app but deliberately does not listen or start provider work.
export function preparePhoneServer({configPath,rootDir=root,env,StoreImpl=Store,LedgerImpl=ProviderLedger,photonFactory=createPhotonClient,modelFactory=createNemotronClient,appFactory=createApp,mode='live-test'}={}){
  let release;
  try{
    if(typeof configPath!=='string'||!configPath.trim())fail();
    const info=lstatSync(configPath);if(!info.isFile()||info.isSymbolicLink()||info.size>65536)fail();
    const raw=JSON.parse(readFileSync(configPath,'utf8'));if(raw?.approved!==true)fail();
    const statePath=resolve(rootDir,'.data/state.json'),ledgerPath=resolve(rootDir,'.data/phone-provider-ledger.json');
    const store=new StoreImpl(statePath),config=validatePhoneConfig(raw,store.read());
    // Do not even inspect credentials until the explicit approval and canonical
    // recipient/message scope have passed validation against the saved exercise.
    const values=env??process.env,photonKey=values.PHOTON_API_KEY,nvidiaKey=values.NVIDIA_API_KEY,port=Number(values.PORT||4173);
    // The normal server must be stopped first. Sharing its exact port prevents
    // another launcher on a different port from writing the same exercise file.
    if(typeof photonKey!=='string'||!/^pho_sk_[A-Za-z0-9._~+\/-]+=*$/.test(photonKey)||photonKey.length>4096||/\s/.test(photonKey)||typeof nvidiaKey!=='string'||!nvidiaKey.trim()||nvidiaKey.length>2048||/\s/.test(nvidiaKey)||port!==4173)fail();
    release=acquireLock(statePath);
    const ledger=new LedgerImpl(ledgerPath);ledger.setMappings(config.identities);
    const client=photonFactory({enabled:true,projectId:config.scope.projectId,apiKey:photonKey});
    const modelClient=modelFactory({enabled:true,baseUrl:'https://integrate.api.nvidia.com/v1',apiKey:nvidiaKey});
    const phone=createPhoneRuntime({enabled:true,store,ledger,client,modelClient,scope:config.scope,replyApproval:config.replyApproval,maxModelRequests:config.maxModelRequests,mode});
    const app=appFactory(store,undefined,undefined,{phone});
    let cleanupPromise;
    const cleanup=()=>cleanupPromise??=(phone.shutdown().then(()=>release()));app.once?.('close',()=>{void cleanup();});
    return {app,phone,port,release:cleanup};
  }catch(error){release?.();if(error instanceof PhoneRuntimeError)throw error;fail();}
}

export async function shutdownPhoneServer(session){
  const drained=session.phone.shutdown();
  await new Promise(resolveClose=>{
    if(!session.app.listening){resolveClose();return;}
    session.app.close(resolveClose);
    // SSE streams are active HTTP requests and otherwise keep close pending.
    session.app.closeAllConnections?.();
  });
  await drained;await session.release();
}

async function main(){
  let session;
  try{
    session=preparePhoneServer(parsePhoneArgs(process.argv.slice(2)));
    await new Promise((resolveListen,reject)=>{session.app.once('error',reject);session.app.listen(session.port,'127.0.0.1',resolveListen);});
    console.log(`Beacon phone test: http://127.0.0.1:${session.port}\nProvider polling, interpretation and replies require explicit local actions.`);
    let stopping=false;const close=()=>{if(stopping)return;stopping=true;void shutdownPhoneServer(session);};process.on('SIGINT',close);process.on('SIGTERM',close);
  }catch(error){await session?.release();console.error(error?.code==='EADDRINUSE'?'The local port is in use. Stop the normal Beacon server before starting the phone test.':error instanceof PhoneRuntimeError?error.message:'The approved phone test could not start.');process.exitCode=1;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
