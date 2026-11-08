// Local rehearsal transport. It shares the durable inbox/review pipeline with
// the live integration, but never constructs a provider or reads credentials.
import {randomUUID,createHash} from 'node:crypto';
import {InputError} from './domain.js';
import {captureRawReport,runReportJob} from './report-inbox.js';
import {createDemoExtractor} from './demo-extractor.js';

export const REHEARSAL_TEXT='I saw Elena at Oak School. They need water for two people and the road is blocked.';
export const REHEARSAL_REPLY='Beacon fictional test: Your report was received for human review. This does not confirm safety or that help has been assigned.';
const scenarios=new Set(['message','duplicate','correction','stop']);
const statuses=new Set(['prepared','sending','unknown','accepted','delivered','failed','delivery_unknown']);
const fresh=()=>({version:1,interpretations:0,lastInput:null,replyJobs:{}});
const fail=(message,status=409)=>{throw new InputError(message,status);};
const reportId=value=>typeof value==='string'&&/^R-[A-Za-z0-9-]{1,100}$/.test(value);
const messageId=id=>'M-rehearsal-'+createHash('sha256').update(id).digest('hex').slice(0,24);
const stamp=()=>new Date().toISOString();

function recordReply(state,{reportId:id,text,id:outgoingId}){
  const report=state.reports.find(item=>item.id===id&&item.providerIdentity?.provider==='rehearsal');
  if(!report||report.caseId!=='C104'||!state.cases.some(item=>item.id===report.caseId))fail('The fictional source report is no longer available.');
  if(!state.participants.some(item=>item.id===report.senderId&&item.optedIn===true))fail('The fictional sender has opted out. Reset the rehearsal to start over.');
  if(!state.outbox.some(item=>item.id===outgoingId)){
    state.outbox.push({id:outgoingId,caseId:report.caseId,recipientId:report.senderId,kind:'rehearsal_reply',text,status:'simulated',createdAt:stamp()});
    state.audit.unshift({id:'A-'+randomUUID(),at:stamp(),action:'rehearsal.reply_simulated',detail:`${report.id}: fixed fictional receipt reply; no external message sent.`});
  }
  return {messageId:outgoingId};
}

export function createRehearsalRuntime({store,ledger,extractor=createDemoExtractor(),maxInterpretations=100}={}){
  if(typeof store?.read!=='function'||typeof store?.act!=='function'||typeof store?.reset!=='function'||typeof ledger?.read!=='function'||typeof ledger?.act!=='function'||typeof extractor?.extract!=='function'||!Number.isInteger(maxInterpretations)||maxInterpretations<1||maxInterpretations>100)fail('The local rehearsal is not configured.');
  const privateState=ledger.read();
  // An accidental live-ledger injection must fail before any local reset/write.
  if(privateState.identities.length||['receipts','polls','modelJobs','replyJobs','budgets'].some(key=>Object.keys(privateState[key]).length))fail('Use a separate local rehearsal journal.');
  if(privateState.rehearsal===undefined)ledger.act(next=>{next.rehearsal=fresh();});
  function meta(){const value=ledger.read().rehearsal;if(!value||value.version!==1||!Number.isInteger(value.interpretations)||value.interpretations<0||typeof value.replyJobs!=='object'||Array.isArray(value.replyJobs))fail('The local rehearsal journal needs review.');return value;}
  meta();
  let closed=false,resetting=false,resetRecoveryRequired=false,simulating=false,interpreting=false,controller=new AbortController(),shutdownPromise;
  const operations=new Set();
  const track=promise=>{operations.add(promise);promise.then(()=>operations.delete(promise),()=>operations.delete(promise));return promise;};
  const consent=()=>store.read().participants.some(item=>item.id==='neighbor-1'&&item.source==='fixture'&&item.optedIn===true);
  const ready=()=>{if(closed||resetting)fail('The rehearsal is resetting or closed.');if(resetRecoveryRequired)fail('The rehearsal reset is incomplete. Retry Reset exercise.');};
  function source(id,{allowCommand=false}={}){
    ready();if(!reportId(id))fail('Choose a fictional captured report.',400);
    const snapshot=store.read(),report=snapshot.reports.find(item=>item.id===id&&item.providerIdentity?.provider==='rehearsal'&&item.senderId==='neighbor-1');
    if(!report||(!allowCommand&&(report.caseId!=='C104'||report.processingPath!=='raw_inbox'))||!snapshot.cases.some(item=>item.id==='C104'))fail('The fictional source report is no longer available.');
    return report;
  }
  function replyView(id,job){return {reportId:id,status:statuses.has(job.status)?job.status:'unknown',attempts:job.attempts||0,deliveryChecks:job.deliveryChecks||0,delivered:job.status==='delivered'};}
  function status(){
    const snapshot=store.read(),data=meta(),reports=snapshot.reports.filter(item=>item.providerIdentity?.provider==='rehearsal'),eligible=reports.filter(item=>item.caseId==='C104'&&item.processingPath==='raw_inbox'),ids=new Set(eligible.map(item=>item.id)),optedIn=consent();
    return {enabled:!closed,mode:'rehearsal',source:'local-rehearsal',extractorSource:'local_demo_rules',phoneConfigured:!closed,modelConfigured:!closed,listening:false,sendingEnabled:!closed&&!resetting&&!resetRecoveryRequired&&optedIn,canSimulate:!closed&&!resetting&&!resetRecoveryRequired&&optedIn,canReset:!closed,endsAt:null,modelUsed:data.interpretations,modelLimit:maxInterpretations,replyText:REHEARSAL_REPLY,rehearsalInputText:data.lastInput?.text||REHEARSAL_TEXT,eligibleReportIds:[...ids],replyStates:Object.entries(data.replyJobs).filter(([id])=>ids.has(id)).map(([id,job])=>replyView(id,job)),counts:{captured:reports.length,quarantined:0,queued:eligible.filter(item=>item.modelReview?.status==='queued').length,proposals:eligible.filter(item=>item.modelReview?.status==='proposal_ready').length,failed:eligible.filter(item=>['failed','stale'].includes(item.modelReview?.status)).length,pollsUsed:0,pollLimit:0},lastError:resetRecoveryRequired?'The rehearsal reset is incomplete. Retry Reset exercise.':null,lastStopReason:optedIn?null:'consent_revoked'};
  }
  async function interpret(id,{signal}={}){
    const report=source(id);if(!consent())fail('The fictional sender has opted out. Reset the rehearsal to start over.');
    if(report.modelReview?.status!=='queued')return {ran:false,reportId:id,status:report.modelReview?.status,reason:'not_queued'};
    if(interpreting)return {ran:false,reportId:id,reason:'busy'};
    if(meta().interpretations>=maxInterpretations)return {ran:false,reportId:id,reason:'budget_exhausted'};
    interpreting=true;
    try{
      ledger.act(next=>{next.rehearsal.interpretations++;});
      const activeSignal=signal?AbortSignal.any([controller.signal,signal]):controller.signal;
      return await runReportJob(store,{enabled:true,reportId:id,extractorSource:'local_demo_rules',signal:activeSignal,extractor:(input,options)=>{
        if(!consent())fail('The fictional sender has opted out.');
        return extractor.extract(input,options);
      }});
    }finally{interpreting=false;}
  }
  async function simulate({text,scenario='message'}={}){
    ready();if(!scenarios.has(scenario))fail('Choose a supported rehearsal action.',400);
    if(simulating)fail('A fictional report is still being processed.');
    let input;
    if(scenario==='duplicate'){
      input=meta().lastInput;if(!input)fail('Send a fictional report before replaying it.');
    }else{
      if(typeof text!=='string'||!text.trim()||text.length>3000)fail('Use a fictional message of 1–3000 characters.',400);
      text=text.trim();if(scenario==='stop'&&text!=='STOP')fail('The opt-out preset must contain exactly STOP.',400);
      if(!consent()&&!['STOP','CHECKIN'].includes(text.toUpperCase()))fail('The fictional sender has opted out. Reset the rehearsal to start over.');
      input={messageId:'local-'+randomUUID(),text,caseId:['STOP','CHECKIN'].includes(text.toUpperCase())?null:'C104'};
    }
    simulating=true;
    try{
      if(scenario!=='duplicate')ledger.act(next=>{next.rehearsal.lastInput=input;});
      const captured=store.act(captureRawReport,{provider:'rehearsal',projectId:'beacon-local-rehearsal',messageId:input.messageId,senderId:'neighbor-1',caseId:input.caseId,text:input.text,observedAt:null,dataClass:'synthetic'});
      let interpretation=null;
      if(captured.status==='queued'&&consent())interpretation=await interpret(captured.reportId);
      return {simulated:true,reportId:captured.reportId,duplicate:captured.duplicate,status:interpretation?.status||captured.status,interpretation};
    }finally{simulating=false;}
  }
  function prepare(id){
    source(id);if(!consent())fail('The fictional sender has opted out.');
    ledger.act(next=>{next.rehearsal.replyJobs[id]??={status:'prepared',attempts:0,deliveryChecks:0,messageId:messageId(id)};});
    return replyView(id,meta().replyJobs[id]);
  }
  async function send(id,{manualRetry=false}={}){
    source(id);if(!consent())fail('The fictional sender has opted out.');
    const job=meta().replyJobs[id];if(!job)fail('Approve the displayed simulated reply first.');
    if(['accepted','delivered','failed'].includes(job.status))return replyView(id,job);
    if(job.status!=='prepared'&&!(manualRetry&&['sending','unknown'].includes(job.status)))fail('Confirm an explicit retry after an unknown simulated send.');
    if(job.attempts>=2)fail('The simulated retry limit has been reached. Reset for a new rehearsal.');
    ledger.act(next=>{const current=next.rehearsal.replyJobs[id];current.status='sending';current.attempts++;});
    try{
      store.act(recordReply,{reportId:id,text:REHEARSAL_REPLY,id:job.messageId});
      ledger.act(next=>{next.rehearsal.replyJobs[id].status='accepted';});
    }catch(error){ledger.act(next=>{next.rehearsal.replyJobs[id].status='unknown';});throw error;}
    return replyView(id,meta().replyJobs[id]);
  }
  async function delivery(id){
    source(id);if(!consent())fail('The fictional sender has opted out.');
    const job=meta().replyJobs[id];if(!job||!['accepted','delivery_unknown','delivered'].includes(job.status))fail('Send the approved simulated reply before checking its delivery.');
    if(job.status==='delivered')return replyView(id,job);
    if(job.deliveryChecks>=4)fail('The simulated delivery-check limit has been reached.');
    const exists=store.read().outbox.some(item=>item.id===job.messageId&&item.status==='simulated');
    ledger.act(next=>{const current=next.rehearsal.replyJobs[id];current.deliveryChecks++;current.status=exists?'delivered':'delivery_unknown';});
    return replyView(id,meta().replyJobs[id]);
  }
  return Object.freeze({status,simulate:input=>track(simulate(input)),interpretOne:(id,options)=>track(interpret(id,options)),prepareReply:prepare,sendReply:(id,options)=>track(send(id,options)),checkDelivery:id=>track(delivery(id)),
    pollOnce:async()=>({polled:false,reason:'local_composer',status:status()}),startListening:()=>({started:false,reason:'local_composer',status:status()}),stopListening:()=>({stopped:false,status:status()}),
    async reset(){
      if(closed||resetting)fail('The rehearsal is resetting or closed.');
      resetting=true;controller.abort();
      try{
        await Promise.allSettled([...operations]);
        // Keep the old reply/usage journal if the state reset fails. If the
        // second write fails, expose an incomplete reset and require retry.
        store.reset();resetRecoveryRequired=true;
        ledger.act(next=>{next.rehearsal=fresh();});resetRecoveryRequired=false;
        return {reset:true};
      }finally{if(!closed)controller=new AbortController();resetting=false;}
    },
    shutdown(){if(!shutdownPromise){closed=true;controller.abort();shutdownPromise=Promise.allSettled([...operations]).then(()=>undefined);}return shutdownPromise;}
  });
}
