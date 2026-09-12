import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MultiGpuMiner } from '../src/multi-gpu.js';
import { selectGpus } from '../src/gpu-devices.js';
import { randomPrefix, nonceAt, workHash } from '../src/proof.js';
import { FIXTURE } from '../src/selftest.js';
import { mine } from '../src/miner.js';
import { CONTRACT } from '../src/chain.js';
import { keccak256 } from 'viem';

const devices=[0,1].map(index=>({index,name:'Identical GPU',uuid:String(index+1).repeat(32)}));
const job={...FIXTURE,anchorBlock:100n,price:1n,window:250n,receivedAt:Date.now()};

test('selection distinguishes identical GPU names and rejects duplicate or missing indices',()=>{
  assert.deepEqual(selectGpus(devices,'all'),devices);
  assert.deepEqual(selectGpus(devices,'1,0'),[devices[1],devices[0]]);
  assert.throws(()=>selectGpus(devices,'0,0'),/duplicate/);
  assert.throws(()=>selectGpus(devices,'2'),/unavailable/);
  assert.throws(()=>selectGpus(devices,''),/--gpus/);
});

test('GPU batches run concurrently with disjoint nonce ranges, aggregate counts, and adaptive work sizes',async()=>{
  const calls=[],release=[];
  const workers=devices.map((_,i)=>({batch:(j,p,b,c)=>new Promise(resolve=>{
    calls.push({i,p,b,c});release.push(()=>resolve({count:c,nonce:null,seconds:i?0.04:0.02}));
  }),close:async()=>{}}));
  const engine=new MultiGpuMiner(workers,devices);
  const prefix=randomPrefix();
  const first=engine.batch(job,prefix,0,262144);
  assert.equal(calls.length,2,'both cards must be dispatched before awaiting a result');
  assert.notEqual(calls[0].p,calls[1].p);
  assert.ok(nonceAt(calls[0].p,262143)<nonceAt(calls[1].p,0));
  release.splice(0).forEach(fn=>fn());
  assert.equal((await first).count,524288);
  const second=engine.batch(job,prefix,262144,262144);
  assert.equal(calls[2].c,262144);
  assert.equal(calls[3].c,131072);
  assert.equal(calls[2].p,calls[0].p);
  assert.ok(calls[2].b>=calls[0].b+calls[0].c);
  release.splice(0).forEach(fn=>fn());
  assert.equal((await second).count,393216);
  assert.equal(engine.stats().reduce((sum,gpu)=>sum+gpu.hashes,0),917504);
});

test('a failed GPU stops the combined engine with a visible GPU-specific error',async()=>{
  const events=[];
  const workers=[{batch:async()=>{throw new Error('device lost');}},{batch:async(j,p,b,count)=>({count,nonce:null,seconds:1})}];
  const engine=new MultiGpuMiner(workers,devices,e=>events.push(e));
  await assert.rejects(engine.batch(job,randomPrefix(),0,100),/device lost/);
  assert.equal(engine.stats()[0].status,'FAILED');
  assert.equal(events[0].event,'gpu-error');assert.equal(events[0].index,0);
});

test('the coordinator independently rejects a worker proof outside its assigned nonce range',async()=>{
  const workers=[{batch:async(j,p,b,count)=>({count,nonce:nonceAt(p,b+count),hash:workHash(j,nonceAt(p,b+count)),seconds:1})}];
  const engine=new MultiGpuMiner(workers,[devices[0]]);
  await assert.rejects(engine.batch(job,randomPrefix(),0,100),/invalid proof/);
});

test('simultaneous GPU proofs are saved and counted, with only one transaction submitted for the shared wallet',async()=>{
  const output=await mkdtemp(join(tmpdir(),'hashcats-multigpu-'));
  const workers=devices.map(()=>({batch:async(j,p,b,count)=>({count,nonce:nonceAt(p,b),hash:workHash(j,nonceAt(p,b)),seconds:0.001})}));
  const engine=new MultiGpuMiner(workers,devices);
  const events=[];let sends=0,signs=0;
  const chain={contract:CONTRACT,chain:{id:4663},check:async()=>{},snapshot:async()=>job,verifyHash:async()=>{},
    prepare:async()=>({tx:{},price:1n}),sign:async()=>{signs++;return '0x1234';},client:{
      sendRawTransaction:async()=>{sends++;return keccak256('0x1234');},waitForTransactionReceipt:async()=>({status:'success'})}};
  try {
    const result=await mine({engine,chain,miner:job.miner,submit:true,account:{},maxMints:1,batchSize:4,
      output,pollMs:1,signal:new AbortController().signal,log:e=>events.push(e)});
    assert.equal(result.accepted,1);assert.equal(result.hashes,8);
    assert.equal(sends,1);assert.equal(signs,1);
    assert.equal(events.filter(e=>e.event==='solution').length,2);
    assert.match(events.find(e=>e.event==='discarded').reason,/Simultaneous GPU proof/);
    assert.equal((await readdir(output)).filter(f=>f.startsWith('proof-')).length,2);
  }finally{await rm(output,{recursive:true,force:true});}
});
