// Hashing-only child: never load .env, receive a private key, or submit transactions.
import { readFileSync } from 'node:fs';
import { GpuMiner } from './gpu.js';
import { selftest } from './selftest.js';
let engine,busy=false;
// Ctrl+C belongs to the coordinator; it drains the current batch then closes us.
process.on('SIGINT',()=>{});
process.on('message',async({id,type,options,job,prefix,base,count})=>{
  if(busy){process.send({id,error:'Overlapping GPU requests'});return;}
  busy=true;
  try {
    let result;
    if(type==='init') {
      engine=await GpuMiner.create(options);
      const uuid=readFileSync(process.env.HASHCATS_GPU_ACK,'utf8');
      if(uuid!==process.env.HASHCATS_GPU_UUID)throw new Error('GPU UUID selection was not acknowledged by the Vulkan layer');
      result={...engine.info,uuid};
    } else if(type==='selftest') {
      const tests=[];
      for(const kernel of options.kernel?[options.kernel]:['split','interleaved'])
        await selftest({...options,kernel},event=>tests.push(event));
      if(readFileSync(process.env.HASHCATS_GPU_ACK,'utf8')!==process.env.HASHCATS_GPU_UUID)
        throw new Error('Self-test did not confirm the selected physical GPU');
      result=tests;
    } else if(type==='batch') {
      const start=performance.now();
      result=await engine.batch(job,prefix,base,count);
      result.seconds=(performance.now()-start)/1000;
    } else throw new Error('Unknown GPU worker request');
    process.send({id,result});
  } catch(e){process.send({id,error:e.message});}
  finally{busy=false;}
});
process.on('disconnect',()=>{engine?.close();process.exit(0);});
