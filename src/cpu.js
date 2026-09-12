import { Worker } from 'node:worker_threads';
import { nonceAt, uint256 } from './proof.js';
export class CpuMiner {
  constructor({threads=1}={}) {
    this.workers=Array.from({length:threads},()=>new Worker(new URL('./cpu-worker.js',import.meta.url)));
    this.info={description:`CPU, ${threads} worker(s)`};
  }
  async batch(job,prefix,base,count) {
    nonceAt(prefix,base);uint256(job.target);
    if(!Number.isInteger(count)||count<1||base+count>2**32) throw new Error('Invalid CPU batch');
    const n=Math.min(this.workers.length,count), results=await Promise.all(this.workers.slice(0,n).map((worker,i)=>new Promise((resolve,reject)=>{
      const start=Math.floor(count*i/n), end=Math.floor(count*(i+1)/n);
      const cleanup=()=>{worker.off('message',done);worker.off('error',fail);worker.off('exit',exited);};
      const done=r=>{cleanup();r.error?reject(new Error(r.error)):resolve(r);};
      const fail=e=>{cleanup();reject(e);};
      const exited=code=>fail(new Error(`CPU worker exited (${code})`));
      worker.once('message',done);worker.once('error',fail);worker.once('exit',exited);
      worker.postMessage({job,prefix,base:base+start,count:end-start});
    })));
    const winner=results.filter(r=>r.nonce!==null).sort((a,b)=>a.nonce<b.nonce?-1:1)[0];
    return {nonce:winner?.nonce??null,hash:winner?.hash??null,count:results.reduce((n,r)=>n+r.count,0)};
  }
  async close(){await Promise.all(this.workers.map(w=>w.terminate()));}
}
