import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { GpuMiner } from './gpu.js';
import { MAX256, randomPrefix, nonceAt, workHash } from './proof.js';
export const FIXTURE={miner:'0x1234567890123456789012345678901234567890',prev:42n,anchor:'0x'+'ab'.repeat(32),target:MAX256};
export async function selftest(options={}, log=console.log) {
  const gpu=await GpuMiner.create(options);
  try {
    let checked=0;
    for(const base of [0,255,65535,0xffffff00]) {
      const count=base===0xffffff00?256:259;
      const prefix=randomPrefix();
      const job={...FIXTURE,prev:BigInt('0x'+randomBytes(32).toString('hex')),anchor:'0x'+randomBytes(32).toString('hex')};
      const result=await gpu.batch(job,prefix,base,count,{dump:true});
      assert.equal(result.nonce,nonceAt(prefix,base));
      for(let i=0;i<count;i++) assert.equal(result.hashes[i],workHash(job,nonceAt(prefix,base+i)),`Nonce ${base+i}`);
      checked+=count;
    }
    // All 256 target bits matter, including the strict equality boundary.
    const prefix=randomPrefix(), base=0x12345678, hash=BigInt(workHash(FIXTURE,nonceAt(prefix,base)));
    for(const target of [0n,hash-1n,hash,hash+1n,MAX256]) {
      const r=await gpu.batch({...FIXTURE,target},prefix,base,1);
      assert.equal(r.nonce!==null,hash<target);
    }
    const job={...FIXTURE,target:MAX256>>8n}, prefix2=randomPrefix();
    const r=await gpu.batch(job,prefix2,7,2049,{dump:true});
    const first=r.hashes.findIndex(h=>BigInt(h)<job.target);
    assert.equal(r.nonce,first<0?null:nonceAt(prefix2,7+first));
    checked+=2049;
    log({event:'selftest',kernel:gpu.kernel,ok:true,hashesCompared:checked,boundaryTests:5,device:gpu.info});
    return gpu.info;
  } finally {gpu.close();}
}
