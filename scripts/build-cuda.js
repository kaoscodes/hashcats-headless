import { execFileSync } from 'node:child_process';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const dir=fileURLToPath(new URL('../.native/',import.meta.url));
mkdirSync(dir,{recursive:true});
const temporary=`${dir}cuda-miner-${process.pid}`;
try {
  execFileSync(process.env.NVCC||'nvcc',['-O3','-std=c++17',`-arch=${process.env.CUDA_ARCH||'native'}`,
    fileURLToPath(new URL('../native/cuda-miner.cu',import.meta.url)),'-o',temporary],{stdio:'inherit'});
  renameSync(temporary,`${dir}cuda-miner`);
  console.log('Built native CUDA miner.');
} finally {rmSync(temporary,{force:true});}
