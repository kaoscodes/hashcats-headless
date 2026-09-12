import { parentPort } from 'node:worker_threads';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { inputBytes, nonceAt } from './proof.js';
parentPort.on('message', ({job,prefix,base,count}) => {
  try {
    const bytes = inputBytes(job,prefix), view = new DataView(bytes.buffer);
    const target = job.target.toString(16).padStart(64,'0');
    let nonce = null, hash = null;
    for (let i=0;i<count;i++) {
      view.setUint32(48,base+i,false);
      const digest = Buffer.from(keccak_256(bytes)).toString('hex');
      if (digest < target) {nonce=nonceAt(prefix,base+i);hash='0x'+digest;break;}
    }
    parentPort.postMessage({nonce,hash,count:nonce===null?count:Number(nonce-prefix)-base+1});
  } catch(e) { parentPort.postMessage({error:e.message}); }
});
