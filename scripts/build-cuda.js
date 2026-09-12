import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir=fileURLToPath(new URL('../.native/',import.meta.url));
mkdirSync(dir,{recursive:true});
const temporary=`${dir}cuda-miner-${process.pid}`;
function compile(arch) {
  const result=spawnSync(process.env.NVCC||'nvcc',['-O3','-std=c++17',`-arch=${arch}`,
    fileURLToPath(new URL('../native/cuda-miner.cu',import.meta.url)),'-o',temporary],
    {stdio:['ignore','inherit','pipe'],encoding:'utf8',maxBuffer:16*1024*1024});
  if(result.stderr)process.stderr.write(result.stderr);
  if(result.error)throw result.error;
  return result;
}
try {
  const arch=process.env.CUDA_ARCH||'native';
  let result=compile(arch);
  // Older toolkits can detect a new GPU but cannot emit its native cubin.
  // all-major includes older GPU binaries plus PTX the driver can JIT for new GPUs.
  // Only recover from this specific failure; preserve explicit architecture choices.
  if(result.status!==0 && !result.signal && arch==='native' &&
    /Unsupported gpu architecture ['"]compute_\d+['"]/.test(result.stderr||'')) {
    console.warn('The CUDA toolkit cannot compile directly for this GPU. Retrying with -arch=all-major (includes forward-compatible PTX).');
    console.warn('The first GPU startup may take longer while the driver compiles PTX. A newer toolkit can build native code directly.');
    result=compile('all-major');
  }
  if(result.status!==0)throw new Error(`CUDA compiler failed (${result.signal||result.status}). Check the compiler diagnostics above.`);
  renameSync(temporary,`${dir}cuda-miner`);
  console.log('Built native CUDA miner.');
} finally {rmSync(temporary,{force:true});}
