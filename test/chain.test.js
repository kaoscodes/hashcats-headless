import test from 'node:test';
import assert from 'node:assert/strict';
import { Chain, CONTRACT } from '../src/chain.js';
import { FIXTURE } from '../src/selftest.js';
import { workHash, MAX256 } from '../src/proof.js';
const job={...FIXTURE,anchorBlock:100n,window:250n,price:1000n};
function mocked(fresh={...job,anchorBlock:105n}) {
  const chain=new Chain();chain.snapshot=async()=>fresh;
  chain.client={simulateContract:async args=>({request:args}),estimateContractGas:async()=>100n,
    estimateFeesPerGas:async()=>({maxFeePerGas:5n,maxPriorityFeePerGas:1n})};
  return chain;
}
test('prepared signing request is a call to mine, with current price and fee bounds',async()=>{
  const chain=mocked({...job,anchorBlock:105n,price:2000n});
  const r=await chain.prepare(job,0n,{maxPrice:2000n,maxGas:120n,maxFeePerGas:5n});
  assert.equal(r.request.to,CONTRACT);assert.equal(r.request.data,r.tx.data);
  assert.equal(r.request.value,2000n);assert.equal(r.request.gas,120n);
  assert.equal(r.request.functionName,undefined);assert.equal(r.request.address,undefined);
});
test('stale rounds, expired anchors, changed target and all spending limits are rejected',async()=>{
  for(const fresh of [{...job,prev:43n},{...job,anchorBlock:350n},{...job,anchorBlock:99n},
    {...job,target:BigInt(workHash(job,0n))}])await assert.rejects(mocked(fresh).prepare(job,0n));
  for(const limits of [{maxPrice:999n},{maxGas:119n},{maxFeePerGas:4n}])await assert.rejects(mocked().prepare(job,0n,limits));
});
test('contract simulation rejection prevents preparation',async()=>{
  const chain=mocked();chain.client.simulateContract=async()=>{throw new Error('Anchor invalid');};
  await assert.rejects(chain.prepare(job,0n),/Anchor invalid/);
});
test('snapshot pins all calls to the same block and uses targetFor',async()=>{
  const c=new Chain();const calls=[];c.client={getBlockNumber:async()=>88n};
  c.read=async(name,args,block)=>{calls.push({name,args,block});return name==='currentAnchor'?[77n,FIXTURE.anchor]:name==='targetFor'?MAX256:1n;};
  const s=await c.snapshot(FIXTURE.miner);
  assert.equal(s.anchorBlock,77n);assert.equal(s.blockNumber,88n);
  assert.ok(calls.every(c=>c.block===88n));assert.deepEqual(calls.find(c=>c.name==='targetFor').args,[FIXTURE.miner]);
});
test('actual signer produces an EIP-1559 contract call, never contract creation',async()=>{
  const {custom,parseTransaction,recoverTransactionAddress}=await import('viem');
  const chain=mocked();
  chain.transport=custom({request:async({method})=>{
    if(method==='eth_chainId')return '0x1237';
    throw new Error(`Unexpected network method ${method}`);
  }});
  const account=chain.signer('0x'+'01'.repeat(32)); // Public, deterministic test key.
  const prepared=await chain.prepare({...job,miner:account.address},0n);
  prepared.request.nonce=0;
  const serialized=await chain.sign(prepared,account);
  const tx=parseTransaction(serialized);
  assert.equal(tx.to.toLowerCase(),CONTRACT.toLowerCase());
  assert.equal(tx.data,prepared.tx.data);assert.equal(tx.value,job.price);
  assert.equal(tx.chainId,4663);assert.equal(tx.type,'eip1559');
  assert.equal(await recoverTransactionAddress({serializedTransaction:serialized}),account.address);
});
