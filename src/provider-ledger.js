// Private provider coordination only. Never attach this state to the public Store.
import {readFileSync,mkdirSync,openSync,writeFileSync,fsyncSync,closeSync,renameSync,unlinkSync,lstatSync,chmodSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';

const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp=()=>new Date().toISOString();
const fresh=()=>({schemaVersion:1,identities:[],receipts:{},polls:{},modelJobs:{},replyJobs:{},budgets:{}});
const codes={invalid_configuration:'Private provider storage is not configured correctly.',corrupt_ledger:'Private provider storage could not be read safely.',storage_failed:'Private provider work could not be saved.',invalid_action:'Private provider updates must be synchronous JSON data.',ledger_full:'Private provider storage reached its configured limit.',invalid_receipt:'The private receipt update is invalid.'};
export class ProviderLedgerError extends Error{
  constructor(code){super(codes[code]||codes.storage_failed);this.name='ProviderLedgerError';this.code=Object.hasOwn(codes,code)?code:'storage_failed';}
}
function fail(code){throw new ProviderLedgerError(code);}
function jsonText(value,maxBytes){
  const seen=new Set();
  function check(item,depth=0){
    if(depth>40)fail('invalid_action');
    if(item===null||typeof item==='string'||typeof item==='boolean')return;
    if(typeof item==='number'&&Number.isFinite(item))return;
    if(typeof item!=='object'||seen.has(item)||(!Array.isArray(item)&&Object.getPrototypeOf(item)!==Object.prototype&&Object.getPrototypeOf(item)!==null))fail('invalid_action');
    seen.add(item);for(const child of Object.values(item))check(child,depth+1);seen.delete(item);
  }
  check(value);const text=JSON.stringify(value);
  if(Buffer.byteLength(text)>maxBytes)fail('ledger_full');return text;
}
function checkedState(value){
  if(!object(value)||value.schemaVersion!==1||!Array.isArray(value.identities)||!['receipts','polls','modelJobs','replyJobs','budgets'].every(key=>object(value[key])))fail('corrupt_ledger');
  return value;
}

export class ProviderLedger{
  constructor(path,{maxFileBytes=16777216,maxReceipts=1000,maxEnvelopeBytes=524288}={}){
    if(typeof path!=='string'||!path.trim()||!Number.isInteger(maxFileBytes)||maxFileBytes<1024||maxFileBytes>67108864||!Number.isInteger(maxReceipts)||maxReceipts<1||maxReceipts>10000||!Number.isInteger(maxEnvelopeBytes)||maxEnvelopeBytes<128||maxEnvelopeBytes>1048576)fail('invalid_configuration');
    this.path=path;this.maxFileBytes=maxFileBytes;this.maxReceipts=maxReceipts;this.maxEnvelopeBytes=maxEnvelopeBytes;this.state=fresh();
    try{
      const info=lstatSync(path);if(!info.isFile()||info.isSymbolicLink()||info.size>maxFileBytes)fail('corrupt_ledger');
      this.state=checkedState(JSON.parse(readFileSync(path,'utf8')));jsonText(this.state,maxFileBytes);chmodSync(path,0o600);
    }catch(error){if(error.code!=='ENOENT')fail('corrupt_ledger');}
  }
  read(){return structuredClone(this.state);}
  act(action,...args){
    if(typeof action!=='function')fail('invalid_action');
    const next=this.read();let result;
    try{result=action(next,...args);}catch(error){if(error instanceof ProviderLedgerError)throw error;fail('invalid_action');}
    if(result&&typeof result.then==='function'){void Promise.resolve(result).catch(()=>{});fail('invalid_action');}
    const clonedResult=result===undefined?null:JSON.parse(jsonText(result,this.maxFileBytes));
    checkedState(next);const text=jsonText(next,this.maxFileBytes-1)+'\n';
    const temp=this.path+'.'+randomUUID()+'.tmp';let fd;
    try{
      mkdirSync(dirname(this.path),{recursive:true,mode:0o700});
      fd=openSync(temp,'wx',0o600);writeFileSync(fd,text);fsyncSync(fd);closeSync(fd);fd=undefined;renameSync(temp,this.path);
    }catch{try{if(fd!==undefined)closeSync(fd);}catch{}try{unlinkSync(temp);}catch{}fail('storage_failed');}
    this.state=next;return structuredClone(clonedResult);
  }
  setMappings(identities){
    if(!Array.isArray(identities)||identities.length>100)fail('invalid_configuration');
    jsonText(identities,this.maxFileBytes);
    return this.act(next=>{next.identities=structuredClone(identities);return {count:identities.length};});
  }
  mappings(){return structuredClone(this.state.identities);}
  journalRaw({projectId,platform,messageId=null,envelope,scopeId,mappingSetHash=null}){
    if(typeof projectId!=='string'||typeof platform!=='string'||typeof scopeId!=='string'||(messageId!==null&&typeof messageId!=='string'))fail('invalid_receipt');
    const envelopeHash=digest(JSON.parse(jsonText(envelope,this.maxEnvelopeBytes)));
    const key=messageId===null?digest([projectId,platform,'invalid',envelopeHash]):digest([projectId,platform,messageId]);
    return this.act(next=>{
      const previous=next.receipts[key];
      if(previous){
        const conflict=previous.envelopeHash!==envelopeHash;
        if(conflict&&!previous.conflicts.some(item=>item.envelopeHash===envelopeHash)){
          if(previous.conflicts.length>=8)fail('ledger_full');
          previous.conflicts.push({envelopeHash,envelope:structuredClone(envelope),at:stamp()});
          if(previous.status==='pending'){previous.status='quarantined';previous.reason='provider_identity_conflict';previous.completedAt=stamp();}
        }
        return {receipt:structuredClone(previous),duplicate:true,conflict};
      }
      if(Object.keys(next.receipts).length>=this.maxReceipts)fail('ledger_full');
      const receipt={id:'P-'+randomUUID(),key,projectId,platform,messageId,envelopeHash,envelope:structuredClone(envelope),scopeId,mappingSetHash,binding:null,status:'pending',reportId:null,reason:null,receivedAt:stamp(),completedAt:null,conflicts:[]};
      next.receipts[key]=receipt;return {receipt:structuredClone(receipt),duplicate:false,conflict:false};
    });
  }
  bindReceipt(key,binding){
    return this.act(next=>{const receipt=next.receipts[key];if(!receipt||receipt.status!=='pending')fail('invalid_receipt');if(receipt.binding&&digest(receipt.binding)!==digest(binding))fail('invalid_receipt');receipt.binding=structuredClone(binding);return structuredClone(receipt);});
  }
  beginCapture(key,intent){
    return this.act(next=>{const receipt=next.receipts[key];if(!receipt||receipt.status!=='pending'||!receipt.binding)fail('invalid_receipt');receipt.status='capturing';receipt.captureIntent=structuredClone(intent);return {key,status:'capturing'};});
  }
  markCaptured(key,{reportId}){
    return this.act(next=>{const receipt=next.receipts[key];if(!receipt||!['pending','capturing'].includes(receipt.status)||typeof reportId!=='string'||!receipt.binding)fail('invalid_receipt');receipt.status='captured';receipt.reportId=reportId;receipt.completedAt=stamp();return {key,status:receipt.status,reportId};});
  }
  markQuarantined(key,reason){
    if(typeof reason!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(reason))fail('invalid_receipt');
    return this.act(next=>{const receipt=next.receipts[key];if(!receipt||!['pending','capturing'].includes(receipt.status))fail('invalid_receipt');receipt.status='quarantined';receipt.reason=reason;receipt.completedAt=stamp();return {key,status:receipt.status,reason};});
  }
  reservePoll(scopeId,{maxPolls}){
    return this.act(next=>{
      const count=Object.values(next.polls).filter(poll=>poll.scopeId===scopeId).length;
      if(count>=maxPolls)return {reserved:false,reason:'poll_limit'};
      const id='poll-'+randomUUID();next.polls[id]={id,scopeId,status:'running',receiptKeys:[],startedAt:stamp(),completedAt:null,errorCode:null};return {reserved:true,id};
    });
  }
  completePoll(id,receiptKeys){
    return this.act(next=>{const poll=next.polls[id];if(!poll||poll.status!=='running'||receiptKeys.some(key=>!next.receipts[key]||!['captured','quarantined'].includes(next.receipts[key].status)))fail('invalid_receipt');poll.status='complete';poll.receiptKeys=[...new Set(receiptKeys)];poll.completedAt=stamp();return {id,status:'complete'};});
  }
  failPoll(id,code){
    return this.act(next=>{const poll=next.polls[id];if(!poll||poll.status!=='running'||typeof code!=='string'||!/^[a-z][a-z0-9_]{0,63}$/.test(code))fail('invalid_receipt');poll.status='failed';poll.errorCode=code;poll.completedAt=stamp();return {id,status:'failed'};});
  }
}
