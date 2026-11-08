// Explicit bounded text interpretation. Credentials and private receipts stay
// outside the public Store; the supplied model client is never constructed here.
import {createHash} from 'node:crypto';
import {runReportJob} from './report-inbox.js';
import {photonScopeFingerprint,fixtureCaseFingerprint} from './photon-inbox.js';
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const textHash=value=>createHash('sha256').update(value).digest('hex');
const stamp=()=>new Date().toISOString();
export class NemotronJobError extends Error{
  constructor(code){super(code==='disabled'?'Text interpretation is disabled.':code==='budget_exhausted'?'The approved model test limit has been reached.':'This report is not available for the approved model test.');this.name='NemotronJobError';this.code=code;this.status=code==='disabled'?409:400;}
}
const fail=code=>{throw new NemotronJobError(code);};
export function createNemotronJobs({enabled=false,store,ledger,modelClient,scope,maxRequests=3,timeoutMs=15000,extractorSource='nvidia_nemotron'}={}){
  if(typeof enabled!=='boolean'||!['nvidia_nemotron','local_demo_rules'].includes(extractorSource))fail('invalid_configuration');
  let running=false;
  function authorized(reportId){
    if(typeof store?.read!=='function'||typeof store?.act!=='function'||typeof ledger?.read!=='function'||typeof ledger?.act!=='function'||typeof modelClient?.extract!=='function'||!Number.isInteger(maxRequests)||maxRequests<1||maxRequests>3||!Number.isInteger(timeoutMs)||timeoutMs<50||timeoutMs>30000)fail('invalid_configuration');
    const scopeId=photonScopeFingerprint(scope),privateState=ledger.read(),state=store.read();
    if(Date.now()<Date.parse(scope.from)||Date.now()>Date.parse(scope.to)||state.mode!=='simulation')fail('outside_window');
    const receipts=Object.values(privateState.receipts).filter(item=>item.scopeId===scopeId&&item.status==='captured'&&item.reportId===reportId);
    if(receipts.length!==1)fail('unapproved_report');
    const receipt=receipts[0],binding=receipt.binding,report=state.reports.find(item=>item.id===reportId);
    const matches=binding?privateState.identities.filter(item=>item&&(item.id===binding.identityId||['projectId','platform','personUsrId','spaceId','agentUsrId'].every(key=>item[key]===binding[key]))):[];
    const identity=matches.length===1?matches[0]:null;
    if(!binding||!identity||hash(identity)!==binding.mappingFingerprint||binding.projectId!==scope.projectId||binding.platform!==scope.platform||binding.agentUsrId!==scope.agentUsrId)fail('scope_changed');
    if(receipt.key!==hash([receipt.projectId,receipt.platform,receipt.messageId])||receipt.envelopeHash!==hash(receipt.envelope)||!Array.isArray(receipt.conflicts)||receipt.conflicts.length)fail('source_changed');
    const stopped=Object.values(privateState.receipts).some(item=>item.envelope?.projectId===scope.projectId&&item.envelope.platform===scope.platform&&item.envelope.status==='received'&&item.envelope.sentBy?.id===binding.personUsrId&&item.envelope.receivedBy?.id===scope.agentUsrId&&item.envelope.content?.type==='text'&&typeof item.envelope.content.text==='string'&&item.envelope.content.text.trim().toUpperCase()==='STOP');
    if(stopped)fail('consent_revoked');
    if(!report||report.processingPath!=='raw_inbox'||report.senderId!==binding.fixtureAlias||report.caseId!==binding.caseId||report.text!==receipt.envelope?.content?.text||report.observedAt!==null||report.providerIdentity?.provider!=='photon'||report.providerIdentity.projectId!==scope.projectId||report.providerIdentity.messageId!==receipt.messageId)fail('source_changed');
    if(!identity.approvedTextHashes.includes(textHash(report.text))||['STOP','CHECKIN'].includes(report.text.trim().toUpperCase()))fail('unapproved_report');
    if(!state.participants.some(item=>item.id===binding.fixtureAlias&&item.source==='fixture'&&item.optedIn===true))fail('consent_revoked');
    if(fixtureCaseFingerprint(state,binding.caseId)!==binding.caseFingerprint)fail('case_changed');
    const fingerprint=hash({receiptKey:receipt.key,mappingFingerprint:binding.mappingFingerprint,textHash:textHash(report.text),caseFingerprint:binding.caseFingerprint,extractorSource});
    return {scopeId,receiptKey:receipt.key,report,fingerprint};
  }
  return Object.freeze({
    async interpretOne(reportId,{signal}={}){
      if(!enabled)return {ran:false,reason:'disabled'};
      if(running)return {ran:false,reason:'busy'};
      if(signal!==undefined&&!(signal instanceof AbortSignal))fail('invalid_configuration');
      if(signal?.aborted)return {ran:false,reason:'cancelled'};
      const allowed=authorized(reportId);
      if(allowed.report.modelReview?.status!=='queued')return {ran:false,reason:'not_queued',reportId};
      const reservation=ledger.act(next=>{
        const existing=next.modelJobs[reportId];
        if(existing)return {reserved:false,reason:existing.fingerprint===allowed.fingerprint?'already_reserved':'source_changed'};
        const budget=next.budgets[allowed.scopeId]??{};
        if((budget.modelMaxRequests!==undefined&&budget.modelMaxRequests!==maxRequests)||!Number.isInteger(budget.modelRequests??0)||(budget.modelRequests??0)<0)return {reserved:false,reason:'budget_changed'};
        if((budget.modelRequests??0)>=maxRequests)return {reserved:false,reason:'budget_exhausted'};
        next.budgets[allowed.scopeId]={...budget,modelMaxRequests:maxRequests,modelRequests:(budget.modelRequests??0)+1};
        next.modelJobs[reportId]={reportId,scopeId:allowed.scopeId,receiptKey:allowed.receiptKey,fingerprint:allowed.fingerprint,extractorSource,status:'reserved',reservedAt:stamp(),completedAt:null,result:null};
        return {reserved:true};
      });
      if(!reservation.reserved)return {ran:false,reason:reservation.reason,reportId};
      running=true;
      try{
        const result=await runReportJob(store,{enabled:true,reportId,timeoutMs,signal,extractorSource,extractor:async(input,options)=>{
          // STOP or a changed mapping may arrive between reservation/claim and
          // invocation. Check immediately before the provider request.
          const current=authorized(reportId);
          if(current.fingerprint!==allowed.fingerprint||input.text!==current.report.text)fail('source_changed');
          return modelClient.extract(input,options);
        }});
        ledger.act(next=>{
          const job=next.modelJobs[reportId];if(!job||job.fingerprint!==allowed.fingerprint)return {recorded:false};
          Object.assign(job,{status:result.status||'not_run',completedAt:stamp(),result:{ran:Boolean(result.ran),completed:Boolean(result.completed),reason:result.reason||null,errorCode:result.errorCode||null}});return {recorded:true};
        });
        return result;
      }finally{running=false;}
    },
    status(){
      if(!enabled)return {enabled:false,maxRequests,usedRequests:0};
      const scopeId=photonScopeFingerprint(scope),budget=ledger.read().budgets[scopeId]||{};
      return {enabled:true,maxRequests,usedRequests:budget.modelRequests||0};
    }
  });
}
