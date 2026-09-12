import { CudaMiner, discoverCudaGpus } from './cuda.js';
import { MultiGpuMiner } from './multi-gpu.js';
import { selectGpus } from './gpu-devices.js';
import { selftest } from './selftest.js';

export async function createCudaFleet(options={},log=()=>{},dependencies={}) {
  const discover=dependencies.discover??discoverCudaGpus, create=dependencies.create??(options=>CudaMiner.create(options));
  const devices=selectGpus(await discover(),options.gpus??'all','CUDA');
  const results=await Promise.allSettled(devices.map(async device=>{
    const miner=await create({...options,device:device.index});
    if(miner.info.uuid!==device.uuid) {
      await miner.close();throw new Error(`CUDA GPU ${device.index} UUID changed during selection`);
    }
    return miner;
  }));
  const failed=results.find(r=>r.status==='rejected');
  if(failed){await Promise.all(results.filter(r=>r.status==='fulfilled').map(r=>r.value.close()));throw failed.reason;}
  const workers=results.map(({value:miner},i)=>({
    async batch(...args) {
      const start=performance.now();
      try {return {...await miner.batch(...args),seconds:(performance.now()-start)/1000};}
      catch(error){throw new Error(`CUDA GPU ${devices[i].index}: ${error.message}`);}
    },
    close:()=>miner.close(),
  }));
  return new MultiGpuMiner(workers,devices,log,'CUDA');
}

export async function selftestCudaGpus(options,log) {
  const devices=selectGpus(await discoverCudaGpus(),options.gpus??'all','CUDA');
  for(const device of devices) {
    await selftest({...options,engine:'cuda',device:device.index},event=>{
      if(event.device.uuid!==device.uuid)throw new Error(`CUDA GPU ${device.index} UUID changed during self-test`);
      log({...event,gpuIndex:device.index,uuid:device.uuid});
    });
  }
}
