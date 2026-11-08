import test from 'node:test';
import assert from 'node:assert/strict';
import {archiveImageUrl,createArchiveImageState,archiveSelectedId} from '../public/archive-view.js';

const origin='http://127.0.0.1:4173';
test('archive image URLs accept only same-origin PNGs in the served image allowlist path',()=>{
  assert.equal(archiveImageUrl('/api/satellite/images/harvey_001_pre_disaster.png',origin),origin+'/api/satellite/images/harvey_001_pre_disaster.png');
  assert.equal(archiveImageUrl(origin+'/api/satellite/images/pair-after.png',origin),origin+'/api/satellite/images/pair-after.png');
  assert.equal(archiveImageUrl('/api/satellite/images/%70air.png',origin),origin+'/api/satellite/images/pair.png');
  for(const source of [undefined,null,{},42,'',' ', ' /api/satellite/images/pair.png', '/api/satellite/images/pair.png\n',
    'https://example.com/api/satellite/images/pair.png','http://localhost:4173/api/satellite/images/pair.png',
    '//example.com/api/satellite/images/pair.png','data:image/png;base64,abc','javascript:alert(1)',
    '/api/satellite/images/../state','/api/satellite/images/%2e%2e/state','/api/satellite/images/dir%2fpair.png',
    '/api/satellite/images/%252e%252e.png','/api/satellite/images/pair.png?source=elsewhere','/api/satellite/images/pair.png#after',
    '/api/satellite/images/pair.svg','/api/satellite/images/pair.png/extra','/api/satellite/images/pair%00.png',
    '/api/satellite/images/pair\\after.png','/other/pair.png',origin.replace('http://','http://user:password@')+'/api/satellite/images/pair.png']){
    assert.equal(archiveImageUrl(source,origin),null,String(source));
  }
});

test('comparison is unavailable until both archived images load, in either order',()=>{
  for(const order of [['before','after'],['after','before']]){
    const images=createArchiveImageState(),token=images.begin();
    assert.equal(images.snapshot().phase,'loading');
    assert.equal(images.settle(token,order[0],true).phase,'loading');
    const ready=images.settle(token,order[1],true);
    assert.equal(ready.phase,'ready');assert.equal(ready.before,'ready');assert.equal(ready.after,'ready');
  }
});

test('one image failure makes the entire comparison unavailable even when its partner succeeds late',()=>{
  for(const failedSide of ['before','after']){
    const images=createArchiveImageState(),token=images.begin(),other=failedSide==='before'?'after':'before';
    assert.equal(images.settle(token,failedSide,false).phase,'error');
    assert.equal(images.settle(token,other,true).phase,'error');
    assert.equal(images.snapshot()[failedSide],'error');
  }
});

test('changing the selected pair ignores old successes and errors while the new pair loads',()=>{
  const images=createArchiveImageState(),oldPair=images.begin();
  images.settle(oldPair,'before',true);
  const newPair=images.begin();
  images.settle(oldPair,'after',false);images.settle(oldPair,'before',true);
  assert.deepEqual(images.snapshot(),{generation:newPair,phase:'loading',before:'loading',after:'loading'});
  images.settle(newPair,'after',true);assert.equal(images.snapshot().phase,'loading');
  images.settle(newPair,'before',true);assert.equal(images.snapshot().phase,'ready');
  images.settle(oldPair,'after',false);assert.equal(images.snapshot().phase,'ready');
});

test('refresh invalidates a pending pair before any replacement inventory has arrived',()=>{
  const images=createArchiveImageState(),oldPair=images.begin();
  images.settle(oldPair,'after',true);images.invalidate();
  images.settle(oldPair,'before',true);images.settle(oldPair,'after',false);
  assert.equal(images.snapshot().phase,'idle');
  const retry=images.begin();images.settle(retry,'before',true);images.settle(retry,'after',true);
  assert.equal(images.snapshot().phase,'ready');
});

test('retry starts a fresh two-image attempt; a previous failure cannot spoil it',()=>{
  const images=createArchiveImageState(),failed=images.begin();images.settle(failed,'before',false);
  const retry=images.begin();images.settle(failed,'after',false);
  assert.equal(images.settle(retry,'before',true).phase,'loading');
  assert.equal(images.settle(retry,'after',true).phase,'ready');
});

test('duplicate callbacks and caller-mutated snapshots cannot turn a partial pair into a ready pair',()=>{
  const images=createArchiveImageState(),token=images.begin();
  const partial=images.settle(token,'before',true);partial.after='ready';partial.phase='ready';
  images.settle(token,'before',true);images.settle(token,'unknown',true);
  assert.equal(images.snapshot().phase,'loading');assert.equal(images.snapshot().after,'loading');
});


test('temporary empty archive inventories retain the chosen study area through recovery',()=>{
  const tiles=[{id:'harvey_001'},{id:'harvey_002'},{id:'harvey_003'}],before=structuredClone(tiles);
  let selected=archiveSelectedId(tiles,'harvey_003');assert.equal(selected,'harvey_003');
  selected=archiveSelectedId([],selected);assert.equal(selected,'harvey_003');
  selected=archiveSelectedId(tiles,selected);assert.equal(selected,'harvey_003');
  assert.equal(archiveSelectedId([{id:'replacement'}],selected),'replacement');
  assert.equal(archiveSelectedId([],null),null);assert.deepEqual(tiles,before);
});
