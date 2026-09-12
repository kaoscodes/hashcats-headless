import test from 'node:test';
import assert from 'node:assert/strict';
import { encodePacked, keccak256, decodeFunctionData } from 'viem';
import { inputBytes, workHash, validProof, nonceAt, randomPrefix, MAX256, transaction, MINE_ABI } from '../src/proof.js';
import { FIXTURE } from '../src/selftest.js';
import { CpuMiner } from '../src/cpu.js';
test('packed input agrees with Ethereum ABI across uint256 and endian boundaries',()=>{
  for(const nonce of [0n,255n,256n,0xffffffffn,0x100000000n,MAX256]) {
    const job={...FIXTURE,prev:MAX256};
    const packed=encodePacked(['address','uint256','uint256','bytes32'],[job.miner,nonce,job.prev,job.anchor]);
    assert.equal(inputBytes(job,nonce).length,116);
    assert.equal(workHash(job,nonce),keccak256(packed));
  }
});
test('known hash and strict full-width target comparison',()=>{
  const h='0x7d4dbea479d4162901c6dafe6acb0c5508a47d9b319a4b6c620c03268be72980';
  assert.equal(workHash(FIXTURE,0n),h);
  assert.equal(validProof({...FIXTURE,target:BigInt(h)},0n),false);
  assert.equal(validProof({...FIXTURE,target:BigInt(h)+1n},0n),true);
  assert.equal(validProof({...FIXTURE,target:0n},0n),false);
});
test('nonce allocation has a random 224-bit prefix and rejects wrapping',()=>{
  const p=randomPrefix();assert.equal(p&0xffffffffn,0n);
  assert.equal(nonceAt(p,0xffffffff),p+0xffffffffn);
  for(const n of [-1,2**32,0.5])assert.throws(()=>nonceAt(p,n));
  assert.throws(()=>nonceAt(1n,0));
  assert.throws(()=>workHash(FIXTURE,MAX256+1n));
  assert.throws(()=>workHash({...FIXTURE,anchor:'0x00'},0n));
});
test('mint transaction encodes nonce, original anchor block and mint value',()=>{
  const tx=transaction({...FIXTURE,anchorBlock:123n,price:456n},789n,FIXTURE.miner,4663);
  assert.equal(tx.value,'0x1c8');assert.equal(tx.from,FIXTURE.miner);assert.equal(tx.chainId,4663);
  const decoded=decodeFunctionData({abi:MINE_ABI,data:tx.data});
  assert.equal(decoded.functionName,'mine');assert.deepEqual(decoded.args,[789n,123n]);
});
test('CPU workers cover uneven partitions and find the first matching nonce',async()=>{
  const miner=new CpuMiner({threads:3});
  try {
    const prefix=randomPrefix();const job={...FIXTURE,target:MAX256>>4n};
    let first=null;
    for(let i=23;i<23+513;i++)if(validProof(job,nonceAt(prefix,i))){first=nonceAt(prefix,i);break;}
    const r=await miner.batch(job,prefix,23,513);assert.equal(r.nonce,first);
    const none=await miner.batch({...job,target:0n},prefix,0xffffffff-8,9);
    assert.equal(none.nonce,null);assert.equal(none.count,9);
  }finally{await miner.close();}
});
