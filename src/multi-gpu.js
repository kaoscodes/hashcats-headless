import { discoverGpus, selectGpus } from './gpu-devices.js';
import { GpuProcess } from './gpu-process.js';
import { workHash, nonceAt, MAX256 } from './proof.js';

export class MultiGpuMiner {
  static async create(options={},log=()=>{}) {
    const devices=selectGpus(await discoverGpus(),options.gpus??'all');
    const workers=devices.map(d=>new GpuProcess(d));
    const gpuOptions={backend:'vulkan',kernel:options.kernel,workgroup:options.workgroup,perThread:options.perThread};
    const results=await Promise.allSettled(workers.map(w=>w.request('init',{options:gpuOptions})));
    const failed=results.find(r=>r.status==='rejected');
    if(failed){await Promise.all(workers.map(w=>w.close()));throw failed.reason;}
    return new MultiGpuMiner(workers,devices,log);
  }
  constructor(workers,devices,log=()=>{},backend='Vulkan') {
    this.workers=workers;this.log=log;this.busy=false;
    this.rows=devices.map(d=>({...d,hashes:0,hashrate:0,status:'READY'}));
    this.info={device:`${devices.length} ${backend} GPU${devices.length===1?'':'s'}`,gpus:this.rows};
  }
  stats(){return this.rows.map(row=>({...row}));}
  async batch(job,prefix,base,count) {
    if(this.busy)throw new Error('Overlapping multi-GPU batches are not allowed');
    nonceAt(prefix,base);
    if(!Number.isInteger(count)||count<1||base+count>2**32)throw new Error('Invalid multi-GPU batch');
    this.busy=true;
    const start=performance.now();
    const fastest=Math.max(...this.rows.map(r=>r.computeRate??0));
    // Each card owns a separate 224-bit prefix. The caller advances the counter
    // by count, even when a slower GPU hashes fewer nonces to keep batches short.
    const allocations=this.rows.map((r,i)=>({prefix:(prefix+(BigInt(i)<<32n))&MAX256,
      count:fastest&&r.computeRate?Math.max(Math.min(count,65536),Math.floor(count*r.computeRate/fastest)):count}));
    try {
      const results=await Promise.allSettled(this.workers.map((w,i)=>w.batch(job,allocations[i].prefix,base,allocations[i].count)));
      const seconds=(performance.now()-start)/1000;
      const winners=[];let total=0,failed;
      for(let i=0;i<results.length;i++) {
        const entry=results[i],row=this.rows[i];
        if(entry.status==='rejected') {
          row.status='FAILED';row.hashrate=0;failed??=entry.reason;
          this.log({event:'gpu-error',index:row.index,message:entry.reason.message});continue;
        }
        const r=entry.value;
        if(r.count!==allocations[i].count)throw new Error(`GPU ${row.index} reported an incorrect hash count`);
        total+=r.count;row.hashes+=r.count;row.hashrate=r.count/seconds;row.status='MINING';
        if(r.seconds>0)row.computeRate=r.count/r.seconds;
        if(r.nonce!==null) {
          const lower=nonceAt(allocations[i].prefix,base),upper=lower+BigInt(r.count);
          if(r.nonce<lower||r.nonce>=upper||workHash(job,r.nonce)!==r.hash||BigInt(r.hash)>=job.target)
            throw new Error(`GPU ${row.index} returned an invalid proof`);
          winners.push({nonce:r.nonce,hash:r.hash,gpuIndex:row.index});
        }
      }
      if(failed)throw failed;
      // Only one submission can win a round. Prefer the strongest candidate.
      winners.sort((a,b)=>BigInt(a.hash)<BigInt(b.hash)?-1:1);
      return {count:total,nonce:winners[0]?.nonce??null,hash:winners[0]?.hash??null,solutions:winners};
    }finally{this.busy=false;}
  }
  async close(){await Promise.all(this.workers.map(w=>w.close()));}
}

export async function selftestGpus(options,log) {
  const devices=selectGpus(await discoverGpus(),options.gpus??'all');
  for(const device of devices) {
    const worker=new GpuProcess(device);
    try {
      const results=await worker.request('selftest',{options:{backend:'vulkan',kernel:options.kernel,workgroup:options.workgroup,perThread:options.perThread}});
      for(const event of results)log({...event,gpuIndex:device.index,uuid:device.uuid});
    } finally {await worker.close();}
  }
}
