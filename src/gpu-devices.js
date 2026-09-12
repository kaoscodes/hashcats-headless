import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const exec=promisify(execFile);
export const nativeDir=fileURLToPath(new URL('../.native/',import.meta.url));
let build;
export async function ensureNative() {
  if(process.platform!=='linux')throw new Error('--gpus currently requires Linux with Vulkan.');
  if(!build)build=(async()=>{
    const inputs=['../native/device-select.c','../native/list-devices.c','../scripts/build-vulkan.js'].map(p=>fileURLToPath(new URL(p,import.meta.url)));
    try {
      const oldest=Math.min(...['list-devices','libhashcats_gpu.so','layer.json'].map(p=>statSync(join(nativeDir,p)).mtimeMs));
      if(inputs.every(p=>statSync(p).mtimeMs<=oldest))return;
    }catch{}
    try {await exec(process.execPath,[inputs[2]],{timeout:60000});}
    catch(e){throw new Error(`GPU selector build failed. Install build-essential and libvulkan-dev, then run npm run build:gpu. ${e.stderr||e.message}`);}
  })();
  await build;
}
export async function discoverGpus() {
  await ensureNative();
  const {stdout}=await exec(join(nativeDir,'list-devices'),[],{timeout:30000});
  const devices=JSON.parse(stdout).filter(d=>d.deviceType!==4&&!/swiftshader|llvmpipe|lavapipe|software|warp/i.test(d.name));
  if(!devices.length)throw new Error('No hardware Vulkan GPUs found. Check GPU devices and drivers.');
  const seen=new Set();
  for(const d of devices) {
    if(!/^[0-9a-f]{32}$/.test(d.uuid)||/^0+$/.test(d.uuid)||seen.has(d.uuid))
      throw new Error('Vulkan returned missing or duplicate GPU UUIDs; refusing ambiguous device selection.');
    seen.add(d.uuid);
  }
  return devices;
}
export function selectGpus(devices,selection='all',backend='Vulkan') {
  if(selection==='all')return devices;
  if(!/^\d+(,\d+)*$/.test(selection))throw new Error(`--gpus must be all or comma-separated ${backend} indices, such as 0,1`);
  const indices=selection.split(',').map(Number);
  if(new Set(indices).size!==indices.length)throw new Error('--gpus contains a duplicate GPU index');
  return indices.map(index=>{
    const device=devices.find(d=>d.index===index);
    if(!device)throw new Error(`GPU ${index} is unavailable. Run devices --gpus all to list ${backend} indices.`);
    return device;
  });
}
