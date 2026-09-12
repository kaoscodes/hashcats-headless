import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

if(process.platform!=='linux')throw new Error('UUID GPU selection currently supports Linux/Vulkan.');
const root=fileURLToPath(new URL('../',import.meta.url));
const dir=join(root,'.native');
mkdirSync(dir,{recursive:true});
const temporary=join(dir,`build-${process.pid}`);
mkdirSync(temporary);
try {
  const cc=process.env.CC||'cc';
  const flags=['-std=c11','-D_GNU_SOURCE','-O2','-Wall','-Wextra','-Werror'];
  execFileSync(cc,[...flags,'-fPIC','-shared',join(root,'native/device-select.c'),'-o',join(temporary,'libhashcats_gpu.so'),'-lpthread'],{stdio:'inherit'});
  execFileSync(cc,[...flags,join(root,'native/list-devices.c'),'-o',join(temporary,'list-devices'),'-lvulkan'],{stdio:'inherit'});
  execFileSync(cc,[...flags,join(root,'native/test-device-select.c'),'-o',join(temporary,'test-device-select'),'-lpthread'],{stdio:'inherit'});
  execFileSync(join(temporary,'test-device-select'),[],{stdio:'inherit'});
  for(const file of ['libhashcats_gpu.so','list-devices'])renameSync(join(temporary,file),join(dir,file));
  writeFileSync(join(temporary,'layer.json'),JSON.stringify({file_format_version:'1.1.2',layer:{
    name:'VK_LAYER_HASHCATS_device_select',type:'GLOBAL',library_path:join(dir,'libhashcats_gpu.so'),
    api_version:'1.3.0',implementation_version:1,description:'Hashcats physical GPU UUID selection',
  }},null,2)+'\n');
  renameSync(join(temporary,'layer.json'),join(dir,'layer.json'));
  console.log('Built Vulkan GPU discovery and UUID selection layer.');
} catch(error) {
  console.error('Install build-essential and libvulkan-dev, then run npm run build:gpu.');
  process.exitCode=1;
} finally {rmSync(temporary,{recursive:true,force:true});}
