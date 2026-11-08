// Explicit operator actions only. Provider clients and approval are injected;
// importing or constructing this controller starts no requests or timers.
import {createPhotonInbox,adaptPhotonMessage,photonScopeFingerprint,bindPhotonIdentity} from './photon-inbox.js';
import {createNemotronJobs} from './nemotron-jobs.js';
import {createPhotonReplies} from './photon-replies.js';

const messages={disabled:'The phone test is disabled.',configuration:'The approved phone test is not configured.',outside_window:'The approved phone-test window is not active.',busy:'A phone operation is already in progress.',poll_failed:'The phone poll could not complete. Saved reports remain available.',interpretation_failed:'This report could not be interpreted within the approved test.',reply_failed:'The reviewed reply operation could not complete.',server_in_use:'The phone server cannot start while another phone session holds its data lock.'};
export class PhoneRuntimeError extends Error{
  constructor(code){super(messages[code]||messages.configuration);this.name='PhoneRuntimeError';this.code=Object.hasOwn(messages,code)?code:'configuration';this.status=409;}
}
const reportId=value=>typeof value==='string'&&/^R-[A-Za-z0-9-]{1,100}$/.test(value);
const replyStatuses=new Set(['prepared','sending','unknown','accepted','delivered','failed','delivery_unknown']);
const number=value=>Number.isSafeInteger(value)&&value>=0?value:0;

export function createPhoneRuntime({enabled=false,store,ledger,client,modelClient,scope,replyApproval,maxModelRequests=3,mode='fixture',pollIntervalMs=3000,listenPollLimit=10,timers={setTimeout,clearTimeout}}={}){
  if(typeof enabled!=='boolean'||!['fixture','live-test'].includes(mode)||!Number.isInteger(maxModelRequests)||maxModelRequests<1||maxModelRequests>3||!Number.isInteger(pollIntervalMs)||pollIntervalMs<250||pollIntervalMs>10000||!Number.isInteger(listenPollLimit)||listenPollLimit<1||listenPollLimit>10||typeof timers?.setTimeout!=='function'||typeof timers?.clearTimeout!=='function')throw new PhoneRuntimeError('configuration');
  let privateScope,permit;
  try{privateScope=structuredClone(scope);permit=structuredClone(replyApproval);}catch{throw new PhoneRuntimeError('configuration');}
  let inbox,jobs,replies,listening=false,listenGeneration=0,pollTimer=null,expiryTimer=null,listenerController=null,polling=false,lastError=null,lastStopReason=null,disposed=false,closing=null;
  const shutdownController=new AbortController(),operations=new Set();
  const tracked=promise=>{operations.add(promise);promise.then(()=>operations.delete(promise),()=>operations.delete(promise));return promise;};
  const operationSignal=signal=>signal?AbortSignal.any([shutdownController.signal,signal]):shutdownController.signal;
  const activeWindow=()=>Boolean(privateScope&&Date.parse(privateScope.from)<=Date.now()&&Date.now()<=Date.parse(privateScope.to));
  function configured(){
    try{
      const scopeId=photonScopeFingerprint(privateScope);
      const base=typeof store?.read==='function'&&typeof store?.act==='function'&&typeof ledger?.read==='function'&&typeof ledger?.act==='function';
      return {scopeId,phone:enabled&&!disposed&&base&&client?.enabled!==false&&typeof client?.listReceived==='function',model:enabled&&!disposed&&base&&typeof modelClient?.extract==='function'};
    }catch{return {scopeId:null,phone:false,model:false};}
  }
  function stopped(privateState,snapshot){
    if(!permit)return false;
    const participant=snapshot.participants?.find(item=>item.id===permit.fixtureAlias);
    if(participant&&participant.optedIn!==true)return true;
    return Object.values(privateState.receipts||{}).some(receipt=>{
      const raw=receipt.envelope;return raw?.projectId===privateScope?.projectId&&raw.platform===privateScope?.platform&&raw.status==='received'&&raw.sentBy?.id===permit.personUsrId&&raw.receivedBy?.id===privateScope?.agentUsrId&&raw.content?.type==='text'&&typeof raw.content.text==='string'&&raw.content.text.trim().toUpperCase()==='STOP';
    });
  }
  function replyConfigured(privateState,snapshot){
    if(!permit||typeof permit.text!=='string'||!permit.text.trim()||permit.text.length>1000||!Number.isInteger(permit.maxSendRequests)||permit.maxSendRequests<1||permit.maxSendRequests>2||!Number.isInteger(permit.maxDeliveryChecks)||permit.maxDeliveryChecks<1||permit.maxDeliveryChecks>4)return false;
    const matches=privateState.identities.filter(identity=>identity.projectId===privateScope.projectId&&identity.platform===privateScope.platform&&identity.agentUsrId===privateScope.agentUsrId&&['personUsrId','spaceId','fixtureAlias','caseId'].every(key=>identity[key]===permit[key]));
    if(matches.length!==1)return false;
    try{const current=bindPhotonIdentity(snapshot,matches[0]);return current.id===matches[0].id&&current.caseFingerprint===matches[0].caseFingerprint;}catch{return false;}
  }
  function status(){
    const config=configured(),base={enabled:enabled&&!disposed,mode,source:mode==='fixture'?'injected-fixture':'configured-provider-clients',phoneConfigured:config.phone,modelConfigured:config.model,listening, sendingEnabled:false,endsAt:typeof privateScope?.to==='string'?privateScope.to:null,modelUsed:0,modelLimit:maxModelRequests,replyText:typeof permit?.text==='string'&&permit.text.length<=1000?permit.text:null,eligibleReportIds:[],replyStates:[],counts:{captured:0,quarantined:0,queued:0,proposals:0,failed:0,pollsUsed:0,pollLimit:number(privateScope?.maxPolls)},lastError,lastStopReason};
    if(!enabled||!config.scopeId||typeof ledger?.read!=='function'||typeof store?.read!=='function')return base;
    try{
      const privateState=ledger.read(),snapshot=store.read(),current=Object.values(privateState.receipts).filter(receipt=>receipt.scopeId===config.scopeId),present=new Set(snapshot.reports.map(report=>report.id));
      const captured=current.filter(receipt=>receipt.status==='captured'&&reportId(receipt.reportId)&&present.has(receipt.reportId));
      base.eligibleReportIds=[...new Set(captured.filter(receipt=>snapshot.reports.some(report=>report.id===receipt.reportId&&report.caseId===permit?.caseId&&report.senderId===permit?.fixtureAlias)).map(receipt=>receipt.reportId))];
      const keys=new Set(captured.map(receipt=>receipt.key));
      base.replyStates=Object.entries(privateState.replyJobs).filter(([key,job])=>keys.has(key)&&reportId(job.reportId)).map(([,job])=>({reportId:job.reportId,status:replyStatuses.has(job.status)?job.status:'unavailable',attempts:number(job.attempts),deliveryChecks:number(job.deliveryChecks),delivered:job.status==='delivered'}));
      const reports=snapshot.reports.filter(report=>base.eligibleReportIds.includes(report.id));
      base.modelUsed=number(privateState.budgets[config.scopeId]?.modelRequests);
      Object.assign(base.counts,{captured:captured.length,quarantined:current.filter(receipt=>receipt.status==='quarantined').length,queued:reports.filter(report=>report.modelReview?.status==='queued').length,proposals:reports.filter(report=>report.modelReview?.status==='proposal_ready').length,failed:reports.filter(report=>['failed','stale'].includes(report.modelReview?.status)).length,pollsUsed:Object.values(privateState.polls).filter(poll=>poll.scopeId===config.scopeId).length});
      const usedSends=Object.values(privateState.replyJobs).reduce((sum,job)=>sum+number(job.attempts),0);
      const consentRevoked=stopped(privateState,snapshot);
      if(consentRevoked)base.lastStopReason='consent_revoked';
      base.sendingEnabled=Boolean(config.phone&&typeof client?.reply==='function'&&typeof client?.getDelivery==='function'&&activeWindow()&&privateScope.platform==='imessage'&&replyConfigured(privateState,snapshot)&&usedSends<permit.maxSendRequests&&!consentRevoked);
      base.listening=listening&&activeWindow();return base;
    }catch{return {...base,phoneConfigured:false,modelConfigured:false,sendingEnabled:false,lastError:'The private test state is unavailable.'};}
  }
  function ready(kind='phone'){
    if(!enabled||disposed)throw new PhoneRuntimeError('disabled');
    const config=configured();if(!config[kind])throw new PhoneRuntimeError('configuration');
    if(!activeWindow())throw new PhoneRuntimeError('outside_window');
  }
  function components(){
    if(!inbox)inbox=createPhotonInbox({enabled:true,store,ledger,client,scope:privateScope,messageAdapter:raw=>adaptPhotonMessage(raw,{providerTimestamp:raw.timestamps?.receivedAt})});
    if(!jobs&&configured().model)jobs=createNemotronJobs({enabled:true,store,ledger,modelClient,scope:privateScope,maxRequests:maxModelRequests});
    if(!replies)replies=createPhotonReplies({enabled:true,store,ledger,client,scope:privateScope,approval:permit});
  }
  function stop(reason='manual'){
    const was=listening;listening=false;listenGeneration++;lastStopReason=reason;
    if(pollTimer!==null)timers.clearTimeout(pollTimer);if(expiryTimer!==null)timers.clearTimeout(expiryTimer);pollTimer=expiryTimer=null;
    listenerController?.abort();listenerController=null;return was;
  }
  async function interpretOne(id,{signal}={}){
    ready('model');if(!reportId(id))throw new PhoneRuntimeError('interpretation_failed');
    try{components();return await jobs.interpretOne(id,{signal:operationSignal(signal)});}
    catch{throw new PhoneRuntimeError('interpretation_failed');}
  }
  async function pollOnce({signal}={}){
    ready();if(polling)return {polled:false,reason:'busy',status:status()};polling=true;
    try{
      signal=operationSignal(signal);components();const result=await inbox.pollOnce({signal}),interpretations=[];
      if(stopped(ledger.read(),store.read()))stop('consent_revoked');
      for(const id of result.queuedReportIds||[]){
        if(signal?.aborted||stopped(ledger.read(),store.read()))break;
        if(!configured().model)break;
        try{const interpreted=await interpretOne(id,{signal});interpretations.push({reportId:id,ran:Boolean(interpreted.ran),status:typeof interpreted.status==='string'?interpreted.status:null,reason:typeof interpreted.reason==='string'?interpreted.reason:null});}
        catch{interpretations.push({reportId:id,ran:false,status:null,reason:'interpretation_unavailable'});}
      }
      return {polled:Boolean(result.polled),captured:number(result.captured),duplicates:number(result.duplicates),quarantined:number(result.quarantined),reportIds:(result.reportIds||[]).filter(reportId),interpretations,...(result.reason?{reason:result.reason}:{}),status:status()};
    }catch{if(signal?.aborted)return {polled:false,reason:'cancelled',status:status()};throw new PhoneRuntimeError('poll_failed');}
    finally{polling=false;}
  }
  function startListening(){
    ready();if(listening)return {started:false,status:status()};
    const current=status();if(current.counts.pollsUsed>=privateScope.maxPolls)throw new PhoneRuntimeError('poll_failed');
    try{if(stopped(ledger.read(),store.read()))throw new PhoneRuntimeError('reply_failed');}catch{throw new PhoneRuntimeError('reply_failed');}
    components();listening=true;lastError=null;lastStopReason=null;const generation=++listenGeneration;listenerController=new AbortController();const signal=listenerController.signal;let rounds=0;
    expiryTimer=timers.setTimeout(()=>{if(generation===listenGeneration)stop('outside_window');},Math.max(0,Date.parse(privateScope.to)-Date.now()));
    const tick=async()=>{
      if(!listening||generation!==listenGeneration)return;
      pollTimer=null;rounds++;
      try{
        const result=await tracked(pollOnce({signal}));
        if(!listening||generation!==listenGeneration)return;
        if(['poll_limit','outside_window'].includes(result.reason)||rounds>=listenPollLimit||status().counts.pollsUsed>=privateScope.maxPolls){stop(result.reason||'poll_limit');return;}
      }catch{if(listening&&generation===listenGeneration){lastError='Listening stopped after an unsuccessful phone poll.';stop('poll_failed');}return;}
      if(listening&&generation===listenGeneration)pollTimer=timers.setTimeout(tick,pollIntervalMs);
    };
    pollTimer=timers.setTimeout(tick,0);return {started:true,status:status()};
  }
  function replyAction(action,id,options={}){
    ready();if(!reportId(id))throw new PhoneRuntimeError('reply_failed');
    try{components();return action==='prepare'?replies.prepare({reportId:id,text:permit?.text}):action==='send'?replies.send({reportId:id,manualRetry:options.manualRetry===true}):replies.checkDelivery({reportId:id});}
    catch{throw new PhoneRuntimeError('reply_failed');}
  }
  async function sendReply(id,options){try{return await replyAction('send',id,options);}catch{throw new PhoneRuntimeError('reply_failed');}}
  async function checkDelivery(id){try{return await replyAction('check',id);}catch{throw new PhoneRuntimeError('reply_failed');}}
  return Object.freeze({status,pollOnce:options=>tracked(pollOnce(options)),startListening,stopListening(){return {stopped:stop(),status:status()};},interpretOne:(id,options)=>tracked(interpretOne(id,options)),prepareReply:id=>replyAction('prepare',id),sendReply:(id,options)=>tracked(sendReply(id,options)),checkDelivery:id=>tracked(checkDelivery(id)),
    shutdown(){if(!closing){disposed=true;stop('shutdown');shutdownController.abort();closing=Promise.allSettled([...operations]).then(()=>undefined);}return closing;}
  });
}
