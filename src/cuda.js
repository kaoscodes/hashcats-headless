import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { inputBytes, nonceAt, uint256, workHash } from './proof.js';

// Persistent hashing-only process. Jobs carry public work; signing stays in Node.
export class CudaMiner {
  static async create({workgroup=128,perThread=16,kernel='native',device=0,backend,adapter}={}) {
    if(kernel!=='native')throw new Error('CUDA uses --kernel native');
    if(backend||adapter)throw new Error('CUDA does not use --backend or --adapter');
    if(![64,128,256].includes(workgroup)||!Number.isInteger(perThread)||perThread<1||perThread>1024||!Number.isInteger(device)||device<0)
      throw new Error('Invalid CUDA device or launch settings');
    const miner=new CudaMiner();
    Object.assign(miner,{workgroup,perThread,kernel});
    const env={...process.env};delete env.HASHCATS_PRIVATE_KEY;delete env.NODE_OPTIONS;
    miner.child=spawn(fileURLToPath(new URL('../.native/cuda-miner',import.meta.url)),[String(device)],{env,stdio:['pipe','pipe','pipe']});
    miner.stderr='';
    miner.child.stderr.on('data',chunk=>{miner.stderr=(miner.stderr+chunk).slice(-4000);});
    miner.child.on('error',e=>miner.fail(new Error(`CUDA worker: ${e.message}. Run npm run build:cuda.`)));
    miner.child.stdin.on('error',e=>miner.fail(e));
    miner.child.on('exit',(code,signal)=>miner.fail(new Error(`CUDA worker exited (${signal??code}): ${miner.stderr}`)));
    miner.lines=createInterface({input:miner.child.stdout});
    miner.lines.on('line',line=>{
      const pending=miner.pending;
      if(!pending){miner.fail(new Error('Unexpected CUDA response'));return;}
      miner.pending=null;clearTimeout(pending.timer);
      try{pending.resolve(JSON.parse(line));}catch(e){pending.reject(e);miner.fail(e);}
    });
    try {
      miner.info=await miner.receive();
      const job={miner:'0x1234567890123456789012345678901234567890',prev:42n,anchor:'0x'+'ab'.repeat(32),target:0n};
      const r=await miner.batch(job,0n,0xfffffff0,16,{dump:true});
      if(r.nonce!==null||r.hashes.some((h,i)=>h!==workHash(job,BigInt(0xfffffff0+i))))throw new Error('CUDA startup hash verification failed');
      return miner;
    }catch(e){await miner.close();throw e;}
  }
  fail(error) {
    this.failure??=error;
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(error);this.pending=null;}
  }
  receive() {
    if(this.failure)return Promise.reject(this.failure);
    if(this.pending)return Promise.reject(new Error('Overlapping CUDA requests'));
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.fail(new Error('CUDA request timed out'));this.child.kill('SIGKILL');},120000);
      this.pending={resolve,reject,timer};
    });
  }
  async batch(job,prefix,base,count,{dump=false}={}) {
    if(this.busy)throw new Error('Overlapping CUDA batches are not allowed');
    if(this.failure)throw this.failure;
    nonceAt(prefix,base);
    if(!Number.isInteger(count)||count<1||count>0xffffffff||base+count>2**32)throw new Error('Batch would overflow the 32-bit counter');
    if(dump&&count>65536)throw new Error('Hash dump limited to 65536 nonces');
    const bytes=Buffer.alloc(136);bytes.set(inputBytes(job,prefix));bytes[116]=1;bytes[135]=128;
    const target=uint256(job.target);
    this.busy=true;
    try {
      const response=this.receive();
      this.child.stdin.write(`${bytes.toString('hex')} ${target.toString(16).padStart(64,'0')} ${base} ${count} ${this.workgroup} ${this.perThread} ${Number(dump)}\n`);
      const {index,hashes}=await response;
      if(!Number.isInteger(index)||(index!==0xffffffff&&(index<0||index>=count)))throw new Error('Invalid CUDA winner index');
      if(dump&&(!Array.isArray(hashes)||hashes.length!==count||hashes.some(h=>!/^0x[0-9a-f]{64}$/.test(h))))throw new Error('Invalid CUDA hash dump');
      const nonce=index===0xffffffff?null:nonceAt(prefix,base+index);
      const hash=nonce===null?null:workHash(job,nonce);
      if(nonce!==null&&BigInt(hash)>=target)throw new Error('CUDA proof failed independent CPU verification');
      return {count,nonce,hash,hashes};
    }finally{this.busy=false;}
  }
  async close() {
    this.fail(new Error('CUDA worker closed'));
    if(this.child.pid&&this.child.exitCode===null&&this.child.signalCode===null)await new Promise(resolve=>{
      const timer=setTimeout(()=>this.child.kill('SIGKILL'),2000);
      this.child.once('exit',()=>{clearTimeout(timer);resolve();});this.child.kill('SIGTERM');
    });
    this.lines.close();
  }
}


export async function discoverCudaGpus() {
  const env={...process.env};delete env.HASHCATS_PRIVATE_KEY;delete env.NODE_OPTIONS;
  const {stdout}=await promisify(execFile)(fileURLToPath(new URL('../.native/cuda-miner',import.meta.url)),['--list'],{env,timeout:30000});
  const devices=JSON.parse(stdout);
  if(!Array.isArray(devices)||!devices.length)throw new Error('No visible CUDA GPUs found. Check GPU access and CUDA_VISIBLE_DEVICES.');
  const seen=new Set();
  for(const d of devices) {
    if(!Number.isInteger(d.index)||d.index<0||typeof d.name!=='string'||!/^[0-9a-f]{32}$/.test(d.uuid)||/^0+$/.test(d.uuid)||seen.has(d.uuid))
      throw new Error('CUDA returned invalid or duplicate GPU identities');
    seen.add(d.uuid);
  }
  return devices;
}
