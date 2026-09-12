import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mine, jobUsable } from '../src/miner.js';
import { FIXTURE } from '../src/selftest.js';
import { workHash } from '../src/proof.js';
import { CONTRACT } from '../src/chain.js';
import { keccak256 } from 'viem';
test('freshness limit pauses stale work',()=>{
  assert.ok(jobUsable({receivedAt:100},1000,1000));
  assert.ok(!jobUsable({receivedAt:100},1101,1000));
});
function setup() {
 const job={...FIXTURE,anchorBlock:100n,price:1n,window:250n,receivedAt:Date.now()};
 return {engine:{batch:async(j,p,b)=>({nonce:p+BigInt(b),hash:workHash(j,p+BigInt(b)),count:1})},
  chain:{check:async()=>{},snapshot:async()=>job,verifyHash:async()=>{},contract:CONTRACT,chain:{id:4663}},job};
}
test('proof-only mining writes a decodable artifact and never broadcasts',async()=>{
  const output=await mkdtemp(join(tmpdir(),'hashcats-'));const {engine,chain}=setup();
  try {const r=await mine({engine,chain,miner:FIXTURE.miner,output,pollMs:1,signal:new AbortController().signal,log:()=>{}});
   const proof=JSON.parse(await readFile(r.proofPath,'utf8'));assert.equal(proof.hash,workHash(proof,BigInt(proof.nonce)));assert.equal(r.accepted,0);
  } finally{await rm(output,{recursive:true,force:true});}
});
test('ambiguous broadcast stops after journaling, without resubmission',async()=>{
  const output=await mkdtemp(join(tmpdir(),'hashcats-'));const {engine,chain}=setup();let sends=0;
  chain.prepare=async()=>({tx:{}});chain.sign=async()=>'0x1234';
  chain.client={sendRawTransaction:async()=>{
    sends++;assert.ok((await readdir(output)).some(f=>f.startsWith('signed-transaction')));throw new Error('timeout');
  }};
  try {await assert.rejects(mine({engine,chain,miner:FIXTURE.miner,account:{},submit:true,output,pollMs:1,
    signal:new AbortController().signal,log:()=>{}}),new RegExp(keccak256('0x1234')));assert.equal(sends,1);
  } finally{await rm(output,{recursive:true,force:true});}
});
test('successful submission waits for receipt and obeys max-mints',async()=>{
  const output=await mkdtemp(join(tmpdir(),'hashcats-'));const {engine,chain}=setup();let sends=0;
  const hash=keccak256('0x1234');
  chain.prepare=async()=>({tx:{}});chain.sign=async()=>'0x1234';
  chain.client={sendRawTransaction:async()=>{sends++;return hash;},
    waitForTransactionReceipt:async()=>({status:'success',transactionHash:hash})};
  try {const r=await mine({engine,chain,miner:FIXTURE.miner,account:{},submit:true,maxMints:1,output,pollMs:1,
    signal:new AbortController().signal,log:()=>{}});assert.equal(r.accepted,1);assert.equal(sends,1);
    assert.ok((await readdir(output)).some(f=>f.startsWith('receipt-')));
  }finally{await rm(output,{recursive:true,force:true});}
});

test('receipt timeout emits unknown submission outcome, never a confirmed mint',async()=>{
  const output=await mkdtemp(join(tmpdir(),'hashcats-'));const {engine,chain}=setup();const events=[];
  chain.prepare=async()=>({tx:{}});chain.sign=async()=>'0x1234';
  chain.client={sendRawTransaction:async()=>keccak256('0x1234'),waitForTransactionReceipt:async()=>{throw new Error('receipt timeout');}};
  try {
    await assert.rejects(mine({engine,chain,miner:FIXTURE.miner,submit:true,output,pollMs:1,
      signal:new AbortController().signal,log:e=>events.push(e)}),/receipt timeout/);
    assert.equal(events.find(e=>e.event==='submission-failed').outcome,'unknown');
    assert.ok(!events.some(e=>e.event==='minted'));
    assert.equal(events.at(-1).accepted,0);
  }finally{await rm(output,{recursive:true,force:true});}
});

test('reverted receipt emits a failed mint outcome and preserves its receipt',async()=>{
  const output=await mkdtemp(join(tmpdir(),'hashcats-'));const {engine,chain}=setup();const events=[];
  chain.prepare=async()=>({tx:{}});chain.sign=async()=>'0x1234';
  chain.client={sendRawTransaction:async()=>keccak256('0x1234'),waitForTransactionReceipt:async()=>({status:'reverted'})};
  try {
    await assert.rejects(mine({engine,chain,miner:FIXTURE.miner,submit:true,output,pollMs:1,
      signal:new AbortController().signal,log:e=>events.push(e)}),/Mint reverted/);
    assert.equal(events.find(e=>e.event==='submission-failed').outcome,'reverted');
    assert.ok(!events.some(e=>e.event==='minted'));
    assert.ok((await readdir(output)).some(f=>f.startsWith('receipt-')));
  }finally{await rm(output,{recursive:true,force:true});}
});

test('balance RPC failure is visible but does not prevent mining or delay shutdown for its refresh interval',async()=>{
  const output=await mkdtemp(join(tmpdir(),'hashcats-'));const {engine,chain}=setup();const events=[];
  chain.walletBalance=async()=>{throw new Error('balance endpoint down');};
  const start=performance.now();
  try {
    const result=await mine({engine,chain,miner:FIXTURE.miner,output,pollMs:1,balancePollMs:60000,
      signal:new AbortController().signal,log:e=>events.push(e)});
    assert.ok(result.proofPath);
    assert.ok(events.some(e=>e.event==='wallet-error'));
    assert.ok(performance.now()-start<3000);
  }finally{await rm(output,{recursive:true,force:true});}
});

test('the final dashboard balance is refreshed after a confirmed mint, including its actual price and gas',async()=>{
  const output=await mkdtemp(join(tmpdir(),'hashcats-'));const {engine,chain}=setup();const events=[];
  let confirmed=false;
  chain.walletBalance=async()=>confirmed?800n:1000n;
  chain.prepare=async()=>({tx:{},price:150n});chain.sign=async()=>'0x1234';
  chain.client={sendRawTransaction:async()=>keccak256('0x1234'),waitForTransactionReceipt:async()=>{
    confirmed=true;return {status:'success',gasUsed:10n,effectiveGasPrice:5n};
  }};
  try {
    await mine({engine,chain,miner:FIXTURE.miner,submit:true,output,pollMs:1,
      signal:new AbortController().signal,log:e=>events.push(e)});
    assert.equal(events.filter(e=>e.event==='wallet').at(-1).balance,800n);
    const mint=events.find(e=>e.event==='minted');
    assert.equal(mint.price,150n);assert.equal(mint.gasCost,50n);
    assert.equal(events.at(-1).accepted,1);
  }finally{await rm(output,{recursive:true,force:true});}
});
