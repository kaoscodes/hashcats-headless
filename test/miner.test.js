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
