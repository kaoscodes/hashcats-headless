import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

for(const scenario of ['native','compatibility','explicit','compiler-error','fallback-error']) {
  test(`CUDA build: ${scenario}`, {skip:process.platform==='win32'}, () => {
    const dir=mkdtempSync(join(tmpdir(),'hashcats-build-'));
    try {
      mkdirSync(join(dir,'scripts'));
      mkdirSync(join(dir,'.native'));
      writeFileSync(join(dir,'package.json'),'{"type":"module"}');
      copyFileSync(resolve('scripts/build-cuda.js'),join(dir,'scripts/build-cuda.js'));
      const binary=join(dir,'.native/cuda-miner');
      writeFileSync(binary,'previous build');
      const nvcc=join(dir,'mock-nvcc');
      writeFileSync(nvcc,`#!${process.execPath}
import { appendFileSync, writeFileSync } from 'node:fs';
const args=process.argv.slice(2), arch=args.find(a=>a.startsWith('-arch='));
appendFileSync(process.env.TRACE,arch+'\\n');
writeFileSync(args[args.indexOf('-o')+1],'new build');
if(process.env.SCENARIO==='native')process.exit(0);
if(process.env.SCENARIO==='compiler-error') {
  console.error('host compiler error');process.exit(1);
}
if(arch!=='-arch=all-major') {
  console.error("nvcc fatal   : Unsupported gpu architecture 'compute_120'");process.exit(1);
}
if(process.env.SCENARIO==='fallback-error') {
  console.error('fallback compilation failed');process.exit(1);
}
`,{mode:0o700});
      const trace=join(dir,'trace');
      const result=spawnSync(process.execPath,[join(dir,'scripts/build-cuda.js')],{
        env:{...process.env,NVCC:nvcc,CUDA_ARCH:scenario==='explicit'?'sm_120':'',TRACE:trace,SCENARIO:scenario},
        encoding:'utf8',timeout:20000,
      });
      const retried=['compatibility','fallback-error'].includes(scenario);
      assert.equal(readFileSync(trace,'utf8'),`-arch=${scenario==='explicit'?'sm_120':'native'}\n${retried?'-arch=all-major\n':''}`);
      const success=['native','compatibility'].includes(scenario);
      assert.equal(result.status===0,success,result.stderr);
      assert.equal(readFileSync(binary,'utf8'),success?'new build':'previous build');
      assert.deepEqual(readdirSync(join(dir,'.native')),['cuda-miner']);
      if(retried)assert.match(result.stderr,/forward-compatible PTX/);
      if(scenario==='compiler-error')assert.match(result.stderr,/host compiler error/);
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
}
