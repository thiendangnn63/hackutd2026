import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,statSync,chmodSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ProviderLedger,ProviderLedgerError} from '../src/provider-ledger.js';
function fixture(t){const dir=mkdtempSync(join(tmpdir(),'beacon-private-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return {dir,path:join(dir,'private.json')};}

test('private synchronous transactions persist all namespaces with 0600 and cloned results/reads',t=>{
  const {path}=fixture(t),ledger=new ProviderLedger(path);
  const result=ledger.act(next=>{next.budgets.scope={used:1};next.modelJobs.work={status:'reserved'};next.replyJobs.reply={text:'Private reviewed reply'};return {budget:next.budgets.scope};});
  assert.equal(statSync(path).mode&0o777,0o600);result.budget.used=9;
  const read=ledger.read();read.budgets.scope.used=8;assert.equal(ledger.read().budgets.scope.used,1);
  const restarted=new ProviderLedger(path);assert.equal(restarted.read().replyJobs.reply.text,'Private reviewed reply');assert.deepEqual(restarted.read(),ledger.read());
});

test('failed, asynchronous and non-JSON actions cannot partially commit or expose diagnostic text',async t=>{
  const {path}=fixture(t),ledger=new ProviderLedger(path);ledger.act(next=>{next.budgets.scope={used:1};});const before=readFileSync(path,'utf8');
  for(const action of [next=>{next.budgets.scope.used=10;throw new Error('private-key and phone');},async next=>{next.budgets.scope.used=20;await Promise.resolve();throw new Error('late private-key');},next=>{next.bad=Infinity;},next=>{next.bad=next;}]){
    assert.throws(()=>ledger.act(action),error=>error instanceof ProviderLedgerError&&!String(error).includes('private-key'));assert.equal(readFileSync(path,'utf8'),before);assert.equal(ledger.read().budgets.scope.used,1);
  }
  await new Promise(resolve=>setImmediate(resolve));
});

test('corrupt or linked storage fails closed without overwriting the original file',t=>{
  const {dir,path}=fixture(t);writeFileSync(path,'corrupt private source');assert.throws(()=>new ProviderLedger(path),{code:'corrupt_ledger'});assert.equal(readFileSync(path,'utf8'),'corrupt private source');
  const target=join(dir,'target.json');writeFileSync(target,JSON.stringify({schemaVersion:1,identities:[],receipts:{},polls:{},modelJobs:{},replyJobs:{},budgets:{}}));rmSync(path);symlinkSync(target,path);
  assert.throws(()=>new ProviderLedger(path),{code:'corrupt_ledger'});
});

test('receipt identity survives restart and conflicts retain original raw data privately',t=>{
  const {path}=fixture(t),ledger=new ProviderLedger(path),input={projectId:'project',platform:'imessage',messageId:'message',scopeId:'scope',envelope:{text:'Original',privatePhone:'+12125550199'}};
  const first=ledger.journalRaw(input);const restarted=new ProviderLedger(path);assert.equal(restarted.journalRaw(input).duplicate,true);
  const conflict=restarted.journalRaw({...input,envelope:{text:'Changed',privatePhone:'+12125550199'}});
  assert.equal(conflict.conflict,true);assert.equal(conflict.receipt.status,'quarantined');assert.equal(conflict.receipt.envelope.text,'Original');assert.equal(conflict.receipt.conflicts[0].envelope.text,'Changed');
  assert.equal(Object.keys(restarted.read().receipts).length,1);assert.equal(first.receipt.id,conflict.receipt.id);
});

test('poll completion cannot advance while a raw receipt is pending, and attempts survive restart',t=>{
  const {path}=fixture(t),ledger=new ProviderLedger(path),receipt=ledger.journalRaw({projectId:'project',platform:'sms',messageId:'m',scopeId:'scope',envelope:{text:'Raw'}}).receipt;
  const poll=ledger.reservePoll('scope',{maxPolls:1});assert.equal(poll.reserved,true);assert.throws(()=>ledger.completePoll(poll.id,[receipt.key]));
  assert.equal(ledger.read().polls[poll.id].status,'running');ledger.markQuarantined(receipt.key,'unknown_identity');ledger.completePoll(poll.id,[receipt.key]);
  const restarted=new ProviderLedger(path);assert.equal(restarted.reservePoll('scope',{maxPolls:1}).reason,'poll_limit');assert.equal(restarted.read().polls[poll.id].status,'complete');
});

test('existing private file permissions are tightened and storage limits fail before mutation',t=>{
  const {path}=fixture(t),ledger=new ProviderLedger(path,{maxReceipts:1});ledger.act(()=>({saved:true}));chmodSync(path,0o644);new ProviderLedger(path);assert.equal(statSync(path).mode&0o777,0o600);
  ledger.journalRaw({projectId:'p',platform:'sms',messageId:'1',scopeId:'s',envelope:{text:'First'}});const before=ledger.read();
  assert.throws(()=>ledger.journalRaw({projectId:'p',platform:'sms',messageId:'2',scopeId:'s',envelope:{text:'Second'}}),{code:'ledger_full'});assert.deepEqual(ledger.read(),before);
});
