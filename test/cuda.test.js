import test from 'node:test';
import assert from 'node:assert/strict';
import { CudaMiner } from '../src/cuda.js';
import { FIXTURE } from '../src/selftest.js';
import { nonceAt, workHash, MAX256 } from '../src/proof.js';

function worker(response) {
  const miner=new CudaMiner();
  miner.workgroup=128;miner.perThread=16;
  miner.child={stdin:{write(line){miner.request=line;}}};
  miner.receive=async()=>response;
  return miner;
}
test('CUDA protocol preserves full prefix, padding, counter and target',async()=>{
  const prefix=(MAX256>>32n)<<32n,base=0xfffffffe;
  const miner=worker({index:1});
  const result=await miner.batch(FIXTURE,prefix,base,2);
  assert.equal(result.nonce,nonceAt(prefix,0xffffffff));
  assert.equal(result.hash,workHash(FIXTURE,result.nonce));
  const [input,target,counter,count,group,perThread,dump]=miner.request.trim().split(' ');
  assert.equal(input.length,272);
  assert.equal(input.slice(40,96),'ff'.repeat(28));
  assert.equal(input.slice(96,104),'00000000');
  assert.equal(input.slice(232,234),'01');
  assert.equal(input.slice(270),'80');
  assert.equal(target,'f'.repeat(64));
  assert.deepEqual([counter,count,group,perThread,dump],[String(base),'2','128','16','0']);
});
test('CUDA responses enforce winner bounds and independent CPU verification',async()=>{
  for(const index of [-1,2,NaN,1.5])await assert.rejects(worker({index}).batch(FIXTURE,0n,0,2),/winner index/);
  const nonce=42n,hash=BigInt(workHash(FIXTURE,nonce));
  await assert.rejects(worker({index:0}).batch({...FIXTURE,target:hash},0n,42,1),/CPU verification/);
  assert.equal((await worker({index:0xffffffff}).batch({...FIXTURE,target:0n},0n,0,1)).nonce,null);
  await assert.rejects(worker({index:0xffffffff,hashes:[]}).batch(FIXTURE,0n,0,1,{dump:true}),/hash dump/);
});
test('CUDA rejects overflow, oversized dumps and overlapping work before dispatch',async()=>{
  const miner=worker({index:0xffffffff});
  await assert.rejects(miner.batch(FIXTURE,0n,0xffffffff,2),/overflow/);
  await assert.rejects(miner.batch(FIXTURE,1n,0,1),/prefix/);
  await assert.rejects(miner.batch(FIXTURE,0n,0,65537,{dump:true}),/dump limited/);
  assert.equal(miner.request,undefined);
  let finish;
  miner.receive=()=>new Promise(resolve=>{finish=resolve;});
  const pending=miner.batch(FIXTURE,0n,0,1);
  await assert.rejects(miner.batch(FIXTURE,0n,0,1),/Overlapping/);
  finish({index:0xffffffff});await pending;
});
test('CUDA worker failure rejects pending and future requests',async()=>{
  const miner=new CudaMiner();
  const pending=miner.receive();
  miner.fail(new Error('device lost'));
  await assert.rejects(pending,/device lost/);
  await assert.rejects(miner.receive(),/device lost/);
});

test('CUDA fleet selects and verifies UUIDs, aggregates work and cleans up partial initialization',async()=>{
  const { createCudaFleet }=await import('../src/multi-cuda.js');
  const devices=[0,1].map(index=>({index,name:'Identical NVIDIA GPU',uuid:String(index+1).repeat(32)}));
  const calls=[],closed=[];
  const dependencies={discover:async()=>devices,create:async({device})=>({
    info:devices[device],
    batch:async(job,prefix,base,count)=>{calls.push({device,prefix});return {count,nonce:null,hash:null};},
    close:async()=>{closed.push(device);},
  })};
  const fleet=await createCudaFleet({gpus:'1,0'},()=>{},dependencies);
  assert.match(fleet.info.device,/2 CUDA GPUs/);
  assert.equal((await fleet.batch(FIXTURE,0n,0,32)).count,64);
  assert.deepEqual(calls.map(c=>c.device),[1,0]);
  assert.notEqual(calls[0].prefix,calls[1].prefix);
  await fleet.close();assert.deepEqual(closed,[1,0]);closed.length=0;
  await assert.rejects(createCudaFleet({},()=>{},{...dependencies,create:async options=>{
    if(options.device===1)throw new Error('init failed');
    return dependencies.create(options);
  }}),/init failed/);
  assert.deepEqual(closed,[0]);closed.length=0;
  await assert.rejects(createCudaFleet({gpus:'0'},()=>{},{...dependencies,create:async options=>({
    ...await dependencies.create(options),info:{uuid:devices[1].uuid},
  })}),/UUID changed/);
  assert.deepEqual(closed,[0]);
});
