#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { availableParallelism } from 'node:os';
import { readFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';
import { getAddress, parseEther, parseGwei } from 'viem';
import { GpuMiner } from './gpu.js';
import { CpuMiner } from './cpu.js';
import { Chain } from './chain.js';
import { selftest, FIXTURE } from './selftest.js';
import { randomPrefix, json } from './proof.js';
import { mine } from './miner.js';
try {
  loadEnvFile();
} catch (error) {
  if (error.code !== 'ENOENT') {
    console.error(json({event:'error',message:'Could not load .env from the current working directory.'}));
    process.exit(1);
  }
}
const strings=['kernel','engine','backend','adapter','threads','workgroup','per-thread','batch-size','seconds','address','rpc','contract',
  'poll-ms','max-age-ms','key-file','max-mint-price','max-gas','max-fee-gwei','max-mints','output'];
const {values:v,positionals}=parseArgs({allowPositionals:true,options:{...Object.fromEntries(strings.map(k=>[k,{type:'string'}])),
  help:{type:'boolean',short:'h'},submit:{type:'boolean'},json:{type:'boolean'}}});
const command=positionals[0]??'help';
if(v.help||command==='help') {
  console.log(`Hashcats headless miner, native WebGPU (no browser)

  node src/cli.js devices [--backend metal|vulkan|d3d12] [--adapter NAME]
  node src/cli.js selftest [GPU options]
  node src/cli.js benchmark [--seconds 10] [compute options]
  node src/cli.js status --address 0x...
  node src/cli.js mine --address 0x... [--seconds 60] [compute options]
  node src/cli.js mine --submit --key-file /secure/key --max-mint-price 0.1

Compute options:
  --engine gpu|cpu       GPU is default; CPU is an explicit fallback
  --backend NAME        Dawn backend; normally selected automatically
  --adapter NAME        Dawn adapter name, e.g. 'Apple M4 Pro' or NVIDIA name
  --threads N           CPU worker count (default: available cores minus one)
  --kernel NAME         interleaved (default) or split Keccak lanes
  --workgroup N         GPU workgroup size: 64 (default), 128, or 256
  --per-thread N        Hashes per GPU invocation (default: 16)
  --batch-size N        Nonces per batch (GPU: 8388608, CPU: 4096 per worker)

Chain and mining options:
  --rpc URL             Override Robinhood Chain RPC, chain ID remains 4663
  --contract ADDRESS    Override collection address
  --poll-ms N           Chain poll interval (default: 500)
  --max-age-ms N        Pause after no fresh snapshot (default: 3000)
  --seconds N           Mining duration (default: unlimited)
  --output DIR          Proofs and transaction journals (default: results)
  --submit              Sign and broadcast paid mints; otherwise save first proof
  --key-file PATH       File containing a hex private key, or set HASHCATS_PRIVATE_KEY
  --max-mint-price ETH  Required price ceiling for --submit, excludes gas
  --max-gas N           Gas limit ceiling (default: 1000000)
  --max-fee-gwei N      Fee per gas ceiling (default: 10)
  --max-mints N         Stop after this many successful mints (default: 1)
  --json                Emit JSON lines

Run npm test and npm run test:gpu before mining on a new machine.`);
} else {
  const log=o=>console.log(v.json?json(o):Object.entries(o).map(([k,x])=>`${k}=${typeof x==='object'?json(x):x}`).join(' '));
  const integer=(key,fallback,min=1,max=2**32-1)=>{
    const n=v[key]===undefined?fallback:Number(v[key]);
    if(!Number.isSafeInteger(n)||n<min||n>max)throw new Error(`--${key} must be an integer in ${min}..${max}`);
    return n;
  };
  let engine;
  const controller=new AbortController();
  const stop=()=>controller.abort();
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  try {
    if(positionals.length>1)throw new Error('Unexpected positional argument');
    if(!['devices','selftest','benchmark','status','mine'].includes(command))throw new Error(`Unknown command: ${command}`);
    if(v.engine&&!['gpu','cpu'].includes(v.engine))throw new Error('--engine must be gpu or cpu');
    const threads=integer('threads',Math.max(1,availableParallelism()-1),1,256);
    const options={backend:v.backend,adapter:v.adapter,kernel:v.kernel??'interleaved',workgroup:integer('workgroup',64,64,256),perThread:integer('per-thread',16,1,1024)};
    if(![64,128,256].includes(options.workgroup))throw new Error('--workgroup must be 64, 128 or 256');
    if(v.backend&&!['metal','vulkan','d3d12'].includes(v.backend))throw new Error('--backend must be metal, vulkan or d3d12');
    if(command==='selftest') {
      for(const kernel of v.kernel?[v.kernel]:['split','interleaved'])await selftest({...options,kernel},log);
    }
    else if(command==='devices') {engine=await GpuMiner.create(options);log({event:'device',...engine.info});}
    else if(command==='status') {
      if(!v.address)throw new Error('--address is required');
      const chain=new Chain({rpc:v.rpc,contract:v.contract});await chain.check();
      const job=await chain.snapshot(getAddress(v.address));const verified=await chain.verifyHash(job,0n);
      log({event:'status',...job,verifiedHash:verified});
    } else {
      const cpu=v.engine==='cpu';
      const batchSize=integer('batch-size',cpu?4096*threads:8388608);
      const seconds=integer('seconds',command==='benchmark'?10:0,0,86400*365);
      let chain,account,miner,limits;
      if(command==='mine') {
        chain=new Chain({rpc:v.rpc,contract:v.contract});
        if(v.submit) {
          const key=v['key-file']?(await readFile(v['key-file'],'utf8')).trim():process.env.HASHCATS_PRIVATE_KEY;
          if(!key||!/^0x[0-9a-fA-F]{64}$/.test(key))throw new Error('--submit needs --key-file or HASHCATS_PRIVATE_KEY containing a 0x-prefixed private key');
          if(v['max-mint-price']===undefined)throw new Error('--submit requires --max-mint-price ETH');
          account=chain.signer(key);miner=account.address;
          if(v.address&&getAddress(v.address)!==miner)throw new Error('--address does not match signing key');
          limits={maxPrice:parseEther(v['max-mint-price']),maxGas:BigInt(integer('max-gas',1000000)),maxFeePerGas:parseGwei(v['max-fee-gwei']??'10')};
          if(limits.maxPrice<0n||limits.maxFeePerGas<=0n)throw new Error('Price must be nonnegative; fee limit must be positive');
        } else {if(!v.address)throw new Error('--address is required');miner=getAddress(v.address);}
      }
      engine=cpu?new CpuMiner({threads}):await GpuMiner.create(options);
      log({event:'device',...engine.info});
      if(command==='benchmark') {
        if(seconds<1)throw new Error('Benchmark --seconds must be positive');
        const job={...FIXTURE,target:0n};let prefix=randomPrefix(),base=0,hashes=0;
        await engine.batch(job,prefix,0,Math.min(batchSize,65536));
        const start=performance.now();let report=start;
        while(!controller.signal.aborted&&performance.now()-start<seconds*1000){
          const count=Math.min(batchSize,2**32-base);const r=await engine.batch(job,prefix,base,count);hashes+=r.count;base+=count;
          if(base>=2**32){prefix=randomPrefix();base=0;}
          if(performance.now()-report>=1000){log({event:'benchmark-progress',hashrate:hashes*1000/(performance.now()-start)});report=performance.now();}
        }
        log({event:'benchmark',hashes,seconds:(performance.now()-start)/1000,hashrate:hashes*1000/(performance.now()-start),batchSize,...options});
      } else {
        const pollMs=integer('poll-ms',500,100,60000),maxAgeMs=integer('max-age-ms',3000,500,10000);
        if(maxAgeMs<=pollMs)throw new Error('--max-age-ms must exceed --poll-ms');
        await mine({engine,chain,miner,account,submit:!!v.submit,seconds,pollMs,maxAgeMs,batchSize,
          maxMints:integer('max-mints',1,1,10000),output:v.output??'results',limits,signal:controller.signal,log});
      }
    }
  } catch(e) { console.error(json({event:'error',message:e.shortMessage??e.message}));process.exitCode=1; }
  finally {await engine?.close();process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
