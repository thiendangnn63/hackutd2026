import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { SatelliteService } from '../src/satellite.js';
import { createApp } from '../src/server.js';
import { Store } from '../src/store.js';

const probabilities = {'no-damage':.1,'minor-damage':.7,'major-damage':.1,destroyed:.1};
function fixture(t, {verified=true, executor}={}) {
  const root=mkdtempSync(join(tmpdir(),'satellite-service-test-'));
  t.after(()=>rmSync(root,{recursive:true,force:true}));
  const put=(name,value)=>{ const path=join(root,name); mkdirSync(dirname(path),{recursive:true}); writeFileSync(path,typeof value==='object'&&!Buffer.isBuffer(value)?JSON.stringify(value):value); };
  const weights=Buffer.from('fake test checkpoint, never executed');
  const hash=createHash('sha256').update(weights).digest('hex');
  const prefix=`.data/models/${hash}/`;
  const output={model_sha256:hash,damage_class:'minor-damage',probabilities,state:'estimated',source:'custom_model',calibrated:false};
  put('.data/model-active.json',{modelSha256:hash});
  put(prefix+'best.pt',weights);
  put(prefix+'model_config.json',{architecture:'efficientnet_b0_6channel'});
  put(prefix+'metrics.json',{best_epoch:1,test:{macro_f1:.2,accuracy:.3,per_class:{}},majority_baseline_test:{macro_f1:.1}});
  put(prefix+'attribution.json',{fixture:true});
  put(prefix+'local-verification.json',{verified,modelSha256:hash});
  put(prefix+'app_index.json',{tiles:[{id:'test_tile',width:32,height:24,preFile:'demo_images/test_tile_pre_disaster.png',postFile:'demo_images/test_tile_post_disaster.png',buildings:[{id:'building-1',box:[1,2,20,22],damageClass:'minor-damage',probabilities,source:'cached_model_output',state:'estimated'}]}]});
  put(prefix+'demo_images/test_tile_pre_disaster.png',Buffer.from('pre fixture'));
  put(prefix+'demo_images/test_tile_post_disaster.png',Buffer.from('post fixture'));
  put('.venv/bin/python','not executable: injected executor only');
  return {root,put,prefix,hash,output,service:new SatelliteService(root,executor??(async()=>({stdout:JSON.stringify(output)})))};
}
const selection={tileId:'test_tile',buildingId:'building-1'};
const errorStatus=status=>error=>error.status===status;

test('absent or unreadable bundle is unavailable, not a fabricated prediction',async t=>{
  const f=fixture(t);
  rmSync(join(f.root,'.data'),{recursive:true});
  assert.equal(f.service.status().available,false);
  assert.deepEqual(f.service.status().tiles,[]);
  await assert.rejects(f.service.infer(selection),errorStatus(409));
  f.put('.data/model-active.json','{broken');
  assert.equal(f.service.status().liveInferenceAvailable,false);
});

test('known image pairs, boxes and estimates are explicit; path escape is denied',t=>{
  const {service}=fixture(t);
  const status=service.status();
  assert.equal(status.available,true);
  const tile=status.tiles[0];
  assert.equal(tile.preImageUrl,'/api/satellite/images/test_tile_pre_disaster.png');
  assert.equal(tile.postImageUrl,'/api/satellite/images/test_tile_post_disaster.png');
  assert.deepEqual(tile.buildings[0].box,[1,2,20,22]);
  assert.deepEqual(tile.buildings[0].probabilities,probabilities);
  assert.equal(tile.buildings[0].source,'cached_model_output');
  assert.equal(tile.buildings[0].state,'estimated');
  assert.equal(service.image('test_tile_pre_disaster.png').toString(),'pre fixture');
  for(const name of ['../best.pt','%2e%2e%2fbest.pt','unknown.png','a;touch.png']) assert.throws(()=>service.image(name),errorStatus(404));
});

test('verification and matching model hash gate local inference',async t=>{
  let calls=0;
  const f=fixture(t,{verified:false,executor:async()=>{calls++;}});
  await assert.rejects(f.service.infer(selection),errorStatus(409));
  f.put(f.prefix+'local-verification.json',{verified:true,modelSha256:'0'.repeat(64)});
  await assert.rejects(f.service.infer(selection),errorStatus(409));
  assert.equal(calls,0);
});

test('only bundled selections enter a bounded executable argv, never a shell',async t=>{
  let call;
  const f=fixture(t,{executor:async(...args)=>{call=args;return {stdout:JSON.stringify(f.output)};}});
  for(const input of [{...selection,path:';touch /tmp/pwned'},{...selection,tileId:'../../bad;echo x'},{...selection,buildingId:'$(whoami)'}]) await assert.rejects(f.service.infer(input));
  assert.equal(call,undefined);
  const result=await f.service.infer(selection);
  assert.equal(result.prediction.damageClass,'minor-damage');
  assert.equal(result.prediction.source,'local_model_inference');
  assert.equal(result.prediction.state,'estimated');
  assert.equal(call[0],join(f.root,'.venv/bin/python'));
  assert.deepEqual(call[1].slice(-9),['--pre-image','demo_images/test_tile_pre_disaster.png','--post-image','demo_images/test_tile_post_disaster.png','--box','1','2','20','22']);
  assert.equal(call[2].timeout,90_000);
  assert.equal(call[2].maxBuffer,65536);
  assert.equal(call[2].shell,undefined);
});

test('changed checkpoint is rejected before executor runs',async t=>{
  let calls=0;
  const f=fixture(t,{executor:async()=>{calls++;}});
  f.put(f.prefix+'best.pt','changed');
  await assert.rejects(f.service.infer(selection),errorStatus(409));
  assert.equal(calls,0);
});

test('malformed and failed inference returns safe 503 and unlocks busy state',async t=>{
  const f=fixture(t);
  const invalid=['not json',JSON.stringify({...f.output,model_sha256:'0'.repeat(64)}),JSON.stringify({...f.output,probabilities:{...probabilities,destroyed:2}}),JSON.stringify({...f.output,damage_class:'destroyed'}),JSON.stringify({...f.output,calibrated:true}),JSON.stringify({...f.output,state:'verified'}),JSON.stringify({...f.output,source:'reference_label'})];
  for(const stdout of invalid) {
    f.service.executor=async()=>({stdout});
    await assert.rejects(f.service.infer(selection),error=>error.status===503 && !error.message.includes('secret'));
    assert.equal(f.service.running,false);
  }
  f.service.executor=async()=>{throw new Error('secret process stderr');};
  await assert.rejects(f.service.infer(selection),error=>error.status===503&&!error.message.includes('secret'));
  assert.equal(f.service.running,false);
});

test('only one inference runs at a time; it releases after completion',async t=>{
  let finish;
  const f=fixture(t,{executor:()=>new Promise(resolve=>{finish=resolve;})});
  const first=f.service.infer(selection);
  await assert.rejects(f.service.infer(selection),errorStatus(409));
  finish({stdout:JSON.stringify(f.output)});
  await first;
  assert.equal(f.service.running,false);
});

test('satellite HTTP routes preserve family state and enforce same origin',async t=>{
  const f=fixture(t,{verified:false});
  const store=new Store();
  const before=store.read();
  const app=createApp(store,f.service);
  await new Promise(resolve=>app.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>app.close(resolve)));
  const base=`http://127.0.0.1:${app.address().port}`;
  const status=await fetch(base+'/api/satellite');
  assert.equal(status.status,200);
  assert.equal((await status.json()).liveInferenceAvailable,false);
  const image=await fetch(base+'/api/satellite/images/test_tile_pre_disaster.png');
  assert.equal(image.headers.get('content-type'),'image/png');
  assert.equal(await image.text(),'pre fixture');
  const options={method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(selection)};
  assert.equal((await fetch(base+'/api/satellite/infer',options)).status,403);
  options.headers.origin=base;
  assert.equal((await fetch(base+'/api/satellite/infer',options)).status,409);
  assert.deepEqual(store.read(),before);
});
