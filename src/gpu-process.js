import { fork } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { nativeDir } from './gpu-devices.js';

export class GpuProcess {
  constructor(device) {
    this.device=device;this.pending=new Map();this.serial=0;this.closed=false;this.stderr='';
    this.directory=mkdtempSync(join(tmpdir(),'hashcats-gpu-'));
    const env={...process.env};
    delete env.HASHCATS_PRIVATE_KEY;
    delete env.NODE_OPTIONS; // Do not inherit preload hooks that could load .env.
    env.VK_LAYER_PATH=[nativeDir,env.VK_LAYER_PATH].filter(Boolean).join(delimiter);
    env.VK_INSTANCE_LAYERS=['VK_LAYER_HASHCATS_device_select',env.VK_INSTANCE_LAYERS].filter(Boolean).join(delimiter);
    env.HASHCATS_GPU_UUID=device.uuid;env.HASHCATS_GPU_ACK=join(this.directory,'selected-uuid');
    this.child=fork(new URL('./gpu-worker.js',import.meta.url),[],{env,execArgv:[],serialization:'advanced',stdio:['ignore','ignore','pipe','ipc']});
    this.child.stderr.on('data',chunk=>{this.stderr=(this.stderr+chunk.toString()).slice(-4000);});
    this.child.on('message',({id,result,error})=>{
      const p=this.pending.get(id);if(!p)return;
      clearTimeout(p.timer);this.pending.delete(id);
      error?p.reject(new Error(`GPU ${device.index}: ${error}`)):p.resolve(result);
    });
    this.child.on('error',e=>this.fail(e));
    this.child.on('exit',(code,signal)=>{
      if(!this.closed)this.fail(new Error(`GPU ${device.index} worker exited (${signal??code}). ${this.stderr}`));
    });
  }
  fail(error) {
    this.failure=error;
    for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}
    this.pending.clear();
  }
  request(type,args={}) {
    if(this.failure)return Promise.reject(this.failure);
    if(this.closed)return Promise.reject(new Error(`GPU ${this.device.index} worker is closed`));
    return new Promise((resolve,reject)=>{
      const id=++this.serial;
      const timer=setTimeout(()=>{
        this.fail(new Error(`GPU ${this.device.index} ${type} timed out`));this.child.kill('SIGKILL');
      },120000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.send({id,type,...args},error=>{if(error)this.fail(error);});
    });
  }
  batch(job,prefix,base,count){return this.request('batch',{job,prefix,base,count});}
  async close() {
    if(this.closed)return;
    this.closed=true;this.fail(new Error('GPU worker closed'));
    if(this.child.exitCode===null&&this.child.signalCode===null) {
      await new Promise(resolve=>{
        const timer=setTimeout(()=>this.child.kill('SIGKILL'),2000);
        this.child.once('exit',()=>{clearTimeout(timer);resolve();});
        this.child.kill('SIGTERM');
      });
    }
    rmSync(this.directory,{recursive:true,force:true});
  }
}
