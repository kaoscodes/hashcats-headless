// Sweep GPU settings serially. TUNE_KERNEL selects the kernel; TUNE_SECONDS controls each sample.
import {GpuMiner} from '../src/gpu.js';
import {FIXTURE} from '../src/selftest.js';
import {randomPrefix} from '../src/proof.js';
const seconds=Number(process.env.TUNE_SECONDS??1);
for (const workgroup of [64,128,256]) {
 const gpu=await GpuMiner.create({workgroup,kernel:process.env.TUNE_KERNEL??'interleaved'});
 try {
  for(const perThread of [4,16,64])for(const count of [1048576,8388608]) {
   gpu.perThread=perThread;const job={...FIXTURE,target:0n};let prefix=randomPrefix(),base=0,hashes=0;
   await gpu.batch(job,prefix,0,count);
   const start=performance.now();
   do {await gpu.batch(job,prefix,base,count);hashes+=count;base+=count;if(base+count>2**32){base=0;prefix=randomPrefix();}}while(performance.now()-start<seconds*1000);
   console.log(JSON.stringify({workgroup,perThread,count,mhs:hashes/(performance.now()-start)/1000}));
  }
 }finally{gpu.close();}
}
