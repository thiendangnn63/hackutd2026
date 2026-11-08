// Inactive, injected Photon polling. No env, timers/loops, model or reply client.
import {createHash} from 'node:crypto';
import {captureRawReport} from './report-inbox.js';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textHash=value=>createHash('sha256').update(value).digest('hex');
const id=(kind,value)=>typeof value==='string'&&new RegExp(`^pho_${kind}_[0-7][0-9a-hjkmnp-tv-z]{25}$`).exec(value)?.[0]===value;
const safeHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const bounded=(value,min,max)=>Number.isInteger(value)&&value>=min&&value<=max;
const timestamp=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(Date.parse(value.slice(0,10)+'T00:00:00Z')).toISOString().slice(0,10)===value.slice(0,10);
const quarantineCodes=new Set(['invalid_envelope','unsupported_content','oversized_text','invalid_timestamp','wrong_project','wrong_platform','wrong_agent','outside_test_window','unknown_identity','ambiguous_identity','invalid_mapping','case_changed','unapproved_text','case_reference_conflict','scope_changed','provider_identity_conflict','capture_failed','capture_outcome_unknown']);
const errors={invalid_configuration:'The local phone bridge is not configured correctly.',invalid_scope:'The approved phone-test scope is invalid.',invalid_envelope:'The received event needs private review.',unsupported_content:'The received content needs private review.',oversized_text:'The received text needs private review.',invalid_timestamp:'The provider timestamp needs private review.',poll_failed:'The local phone poll did not complete.',poll_timeout:'The local phone poll timed out.',cancelled:'The local phone poll was cancelled.',storage_failed:'Phone intake could not be saved safely.'};
export class PhotonInboxError extends Error{
  constructor(code){super(errors[code]||errors.poll_failed);this.name='PhotonInboxError';this.code=Object.hasOwn(errors,code)?code:'poll_failed';}
}
const fail=code=>{throw new PhotonInboxError(code);};

export function fixtureCaseFingerprint(state,caseId){
  if(caseId===null)return null;
  const item=state.cases.find(item=>item.id===caseId);if(!item)fail('invalid_configuration');
  return digest({id:item.id,createdAt:item.createdAt,subjectNames:item.subjectNames});
}
export function bindPhotonIdentity(state,input={}){
  const {projectId,platform,personUsrId,spaceId,agentUsrId,fixtureAlias,caseId=null}=input;
  if(state.mode!=='simulation'||!id('prj',projectId)||!['imessage','sms'].includes(platform)||!id('usr',personUsrId)||!id('usr',agentUsrId)||personUsrId===agentUsrId||!id('spc',spaceId)||!state.participants.some(item=>item.id===fixtureAlias&&item.source==='fixture')||(caseId!==null&&typeof caseId!=='string'))fail('invalid_configuration');
  if(input.approvedTextHashes!==undefined&&!Array.isArray(input.approvedTextHashes))fail('invalid_configuration');
  const hashes=[...(input.approvedTextHashes||[])];
  if(input.approvedTexts!==undefined){if(!Array.isArray(input.approvedTexts)||input.approvedTexts.some(text=>typeof text!=='string'||!text.trim()||text.length>3000))fail('invalid_configuration');hashes.push(...input.approvedTexts.map(textHash));}
  if(hashes.length>100||hashes.some(value=>!safeHash(value)))fail('invalid_configuration');
  return {id:digest([projectId,platform,personUsrId,spaceId,agentUsrId]),projectId,platform,personUsrId,spaceId,agentUsrId,fixtureAlias,caseId,caseFingerprint:fixtureCaseFingerprint(state,caseId),approvedTextHashes:[...new Set(hashes)]};
}
function checkedScope(scope){
  if(!object(scope)||typeof scope.id!=='string'||!/^[-a-zA-Z0-9_.]{1,100}$/.test(scope.id)||!id('prj',scope.projectId)||!['imessage','sms'].includes(scope.platform)||!id('usr',scope.agentUsrId)||scope.dataClass!=='synthetic'||!timestamp(scope.from)||!timestamp(scope.to)||Date.parse(scope.to)<Date.parse(scope.from)||Date.parse(scope.to)-Date.parse(scope.from)>3600000||!bounded(scope.maxPages,1,10)||!bounded(scope.maxMessages,1,200)||scope.maxPages>scope.maxMessages||!bounded(scope.maxPolls,1,20))fail('invalid_scope');
  return {id:scope.id,projectId:scope.projectId,platform:scope.platform,agentUsrId:scope.agentUsrId,from:new Date(scope.from).toISOString(),to:new Date(scope.to).toISOString(),maxPages:scope.maxPages,maxMessages:scope.maxMessages,maxPolls:scope.maxPolls,dataClass:'synthetic'};
}
export function photonScopeFingerprint(scope){return digest(checkedScope(scope));}

// The account's verified adapter must supply the exact timestamp field. No
// timestamp key is guessed, and transport time is never an observation time.
export function adaptPhotonMessage(message,{providerTimestamp}={}){
  if(!object(message)||!id('msg',message.id)||!id('prj',message.projectId)||!['imessage','sms'].includes(message.platform)||message.status!=='received'||!id('spc',message.space?.id)||!id('usr',message.sentBy?.id)||!id('usr',message.receivedBy?.id))fail('invalid_envelope');
  if(message.space.projectId!==message.projectId||message.space.platform!==message.platform||message.space.kind!=='direct'||!Array.isArray(message.space.participantIds)||message.space.participantIds.length!==2||new Set(message.space.participantIds).size!==2||!message.space.participantIds.includes(message.sentBy.id)||!message.space.participantIds.includes(message.receivedBy.id)||message.sentBy.kind!=='human'||message.receivedBy.kind!=='agent'||message.sentBy.projectId!==message.projectId||message.receivedBy.projectId!==message.projectId||message.sentBy.platform!==message.platform||message.receivedBy.platform!==message.platform)fail('invalid_envelope');
  if(!object(message.content)||message.content.type!=='text'||message.content.format!=='plain'||typeof message.content.text!=='string'||!message.content.text.trim())fail('unsupported_content');
  if(message.content.text.length>3000)fail('oversized_text');
  if(!timestamp(providerTimestamp))fail('invalid_timestamp');
  return {messageId:message.id,projectId:message.projectId,platform:message.platform,spaceId:message.space.id,personUsrId:message.sentBy.id,agentUsrId:message.receivedBy.id,text:message.content.text,providerTimestamp:new Date(providerTimestamp).toISOString()};
}
function validAdapted(value){return object(value)&&id('msg',value.messageId)&&id('prj',value.projectId)&&['imessage','sms'].includes(value.platform)&&id('spc',value.spaceId)&&id('usr',value.personUsrId)&&id('usr',value.agentUsrId)&&typeof value.text==='string'&&value.text.trim()&&value.text.length<=3000&&timestamp(value.providerTimestamp);}
function boundedRead(client,options,timeoutMs,signal){
  const controller=new AbortController();let timer,abort;
  const stopped=new Promise((resolve,reject)=>{
    timer=setTimeout(()=>{controller.abort();reject(new PhotonInboxError('poll_timeout'));},timeoutMs);
    abort=()=>{controller.abort();reject(new PhotonInboxError('cancelled'));};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  });
  return Promise.race([Promise.resolve().then(()=>{if(controller.signal.aborted)fail('cancelled');return client.listReceived({...options,signal:controller.signal});}),stopped]).finally(()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);});
}

export function createPhotonInbox({enabled=false,store,ledger,client,messageAdapter,scope,timeoutMs=10000}={}){
  if(typeof enabled!=='boolean')fail('invalid_configuration');
  let running=false;
  function ready(){
    if(typeof store?.read!=='function'||typeof store?.act!=='function'||!['read','act','mappings','journalRaw','bindReceipt','beginCapture','markCaptured','markQuarantined','reservePoll','completePoll','failPoll'].every(method=>typeof ledger?.[method]==='function')||typeof client?.listReceived!=='function'||typeof messageAdapter!=='function'||!bounded(timeoutMs,50,30000))fail('invalid_configuration');
    return checkedScope(scope);
  }
  function processReceipt(receipt,active,scopeId,result){
    if(['captured','quarantined'].includes(receipt.status)){result.duplicates++;return;}
    const quarantine=reason=>{ledger.markQuarantined(receipt.key,reason);result.quarantined++;};
    if(receipt.scopeId!==scopeId){quarantine('scope_changed');return;}
    if(receipt.mappingSetHash!==digest(ledger.mappings())){quarantine('invalid_mapping');return;}
    let event;
    try{event=messageAdapter(structuredClone(receipt.envelope));if(event&&typeof event.then==='function'){void Promise.resolve(event).catch(()=>{});fail('invalid_envelope');}if(!validAdapted(event)||event.messageId!==receipt.messageId)fail('invalid_envelope');}
    catch(error){quarantine(quarantineCodes.has(error?.code)?error.code:'invalid_envelope');return;}
    if(event.projectId!==active.projectId){quarantine('wrong_project');return;}
    if(event.platform!==active.platform){quarantine('wrong_platform');return;}
    if(event.agentUsrId!==active.agentUsrId){quarantine('wrong_agent');return;}
    if(Date.parse(event.providerTimestamp)<Date.parse(active.from)||Date.parse(event.providerTimestamp)>Date.parse(active.to)){quarantine('outside_test_window');return;}
    const matches=ledger.mappings().filter(item=>item.projectId===event.projectId&&item.platform===event.platform&&item.personUsrId===event.personUsrId&&item.spaceId===event.spaceId&&item.agentUsrId===event.agentUsrId);
    if(matches.length!==1){quarantine(matches.length?'ambiguous_identity':'unknown_identity');return;}
    const identity=matches[0],state=store.read(),command=event.text.trim().toUpperCase(),stop=command==='STOP';
    let checked;
    try{checked=bindPhotonIdentity(state,identity);}catch{if(!stop){quarantine('case_changed');return;}try{checked=bindPhotonIdentity(state,{...identity,caseId:null});}catch{quarantine('invalid_mapping');return;}}
    if(identity.id!==checked.id||!Array.isArray(identity.approvedTextHashes)){quarantine('invalid_mapping');return;}
    if(!stop&&checked.caseFingerprint!==identity.caseFingerprint){quarantine('case_changed');return;}
    if(!['STOP','CHECKIN'].includes(command)&&!checked.approvedTextHashes.includes(textHash(event.text))){quarantine('unapproved_text');return;}
    const caseId=stop?null:identity.caseId;
    if(!stop&&(event.text.toUpperCase().match(/\bC\d+\b/g)||[]).some(reference=>reference!==caseId)){quarantine('case_reference_conflict');return;}
    const binding={identityId:identity.id,mappingFingerprint:digest(identity),projectId:event.projectId,platform:event.platform,personUsrId:event.personUsrId,spaceId:event.spaceId,agentUsrId:event.agentUsrId,fixtureAlias:identity.fixtureAlias,caseId,caseFingerprint:stop?null:identity.caseFingerprint};
    if(receipt.binding&&digest(receipt.binding)!==digest(binding)){quarantine('invalid_mapping');return;}
    const providerEventId='inbox:'+digest(['photon',event.projectId,event.messageId]);
    const existing=state.reports.find(report=>report.providerEventId===providerEventId);
    if(receipt.status==='capturing'){
      if(existing&&existing.senderId===binding.fixtureAlias&&existing.caseId===caseId&&existing.text===event.text&&existing.observedAt===null){ledger.markCaptured(receipt.key,{reportId:existing.id});result.duplicates++;result.reportIds.push(existing.id);if(existing.modelReview?.status==='queued')result.queuedReportIds.push(existing.id);return;}
      quarantine('capture_outcome_unknown');return;
    }
    if(!receipt.binding)ledger.bindReceipt(receipt.key,binding);
    ledger.beginCapture(receipt.key,{providerEventId,caseFingerprint:binding.caseFingerprint});
    let captured;
    try{
      captured=store.act((next,input)=>{
        if(input.caseId!==null&&fixtureCaseFingerprint(next,input.caseId)!==binding.caseFingerprint)fail('invalid_configuration');
        return captureRawReport(next,input);
      },{dataClass:'synthetic',provider:'photon',projectId:event.projectId,messageId:event.messageId,senderId:binding.fixtureAlias,caseId,text:event.text,observedAt:null});
    }catch{quarantine('capture_failed');return;}
    ledger.markCaptured(receipt.key,{reportId:captured.reportId});result.captured++;result.reportIds.push(captured.reportId);
    if(captured.status==='queued')result.queuedReportIds.push(captured.reportId);
  }
  return Object.freeze({
    async pollOnce({signal}={}){
      if(!enabled)return {polled:false,reason:'disabled'};
      if(running)return {polled:false,reason:'busy'};
      if(signal!==undefined&&!(signal instanceof AbortSignal))fail('invalid_configuration');
      if(signal?.aborted)return {polled:false,reason:'cancelled'};
      const active=ready(),scopeId=photonScopeFingerprint(active),result={polled:false,scopeId,captured:0,duplicates:0,quarantined:0,reportIds:[],queuedReportIds:[]};running=true;let poll;
      try{
        const pending=Object.values(ledger.read().receipts).filter(receipt=>receipt.scopeId===scopeId&&['pending','capturing'].includes(receipt.status));
        for(const receipt of pending.slice(0,active.maxMessages))processReceipt(receipt,active,scopeId,result);
        if(pending.length>active.maxMessages)return {...result,reason:'recovery_limit'};
        if(Date.now()<Date.parse(active.from)||Date.now()>Date.parse(active.to))return {...result,reason:'outside_window'};
        poll=ledger.reservePoll(scopeId,{maxPolls:active.maxPolls});if(!poll.reserved)return {...result,reason:poll.reason};
        const mappingSetHash=digest(ledger.mappings());
        const listed=await boundedRead(client,{platform:active.platform,createdSince:active.from,createdBefore:active.to,pageSize:Math.max(1,Math.floor(active.maxMessages/active.maxPages)),maxPages:active.maxPages},timeoutMs,signal);
        if(!object(listed)||listed.platform!==active.platform||!Array.isArray(listed.items)||listed.items.length>active.maxMessages||!bounded(listed.pages,1,active.maxPages))fail('poll_failed');
        const keys=[];
        for(const envelope of listed.items){
          const messageId=id('msg',envelope?.id)?envelope.id:null;
          const recorded=ledger.journalRaw({projectId:active.projectId,platform:active.platform,messageId,envelope,scopeId,mappingSetHash});keys.push(recorded.receipt.key);
          if(recorded.conflict){if(recorded.receipt.status==='pending')ledger.markQuarantined(recorded.receipt.key,'provider_identity_conflict');result.quarantined++;continue;}
          processReceipt(recorded.receipt,active,scopeId,result);
        }
        ledger.completePoll(poll.id,keys);return {...result,polled:true,pages:listed.pages,received:listed.items.length};
      }catch(error){
        const code=error instanceof PhotonInboxError?error.code:error?.name==='ProviderLedgerError'?'storage_failed':'poll_failed';
        if(poll?.reserved)try{ledger.failPoll(poll.id,code);}catch{/* Original raw receipts remain recoverable. */}
        throw new PhotonInboxError(code);
      }finally{running=false;}
    }
  });
}
