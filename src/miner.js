import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { keccak256, toHex } from 'viem';
import { randomPrefix, nonceAt, workHash, json, transaction } from './proof.js';

export async function saveArtifact(dir,kind,value) {
  await mkdir(dir,{recursive:true,mode:0o700});
  const path=join(dir,`${kind}-${Date.now()}-${randomUUID()}.json`);
  await writeFile(path,json(value)+'\n',{mode:0o600,flag:'wx'});
  return path;
}
export function jobUsable(job,now,maxAgeMs){return job && now-job.receivedAt<=maxAgeMs;}
export async function mine({engine,chain,miner,account,submit=false,seconds=0,pollMs=500,maxAgeMs=3000,
  batchSize=8388608,maxMints=1,output='results',limits={},signal,log=console.log}) {
  await chain.check();
  let latest=await chain.snapshot(miner);
  await chain.verifyHash(latest,nonceAt(randomPrefix(),0));
  log({event:'job',...latest,targetHex:toHex(latest.target,{size:32})});
  let polling=true, pollError=null;
  const poll=async()=>{
    while(polling&&!signal.aborted) {
      try {await sleep(pollMs,undefined,{signal});} catch {break;}
      if(!polling)break;
      try {const next=await chain.snapshot(miner); if (next.blockNumber >= latest.blockNumber) latest=next; pollError=null;} catch(e){pollError=e.shortMessage??e.message;}
    }
  };
  const pollPromise=poll();
  const start=performance.now();let lastReport=start,hashes=0,lastHashes=0,accepted=0,jobKey='',prefix=randomPrefix(),base=0;
  try {
    while(!signal.aborted && (!seconds || performance.now()-start<seconds*1000)) {
      if(!jobUsable(latest,Date.now(),maxAgeMs)) {
        if(performance.now()-lastReport>1000){log({event:'paused',reason:'Chain snapshot is stale',detail:pollError});lastReport=performance.now();}
        await sleep(100,undefined,{signal}).catch(()=>{});continue;
      }
      const job=latest;
      const key=`${job.prev}:${job.anchor}`;
      if(key!==jobKey || base>=2**32){jobKey=key;prefix=randomPrefix();base=0;}
      const count=Math.min(batchSize,2**32-base),result=await engine.batch(job,prefix,base,count);
      base+=count;hashes+=result.count;
      if(performance.now()-lastReport>=1000){const now=performance.now();log({event:'progress',hashes,hashrate:(hashes-lastHashes)*1000/(now-lastReport),elapsedSeconds:(now-start)/1000,anchorBlock:job.anchorBlock});lastReport=now;lastHashes=hashes;}
      if(signal.aborted)break;
      if(result.nonce===null)continue;
      if(BigInt(workHash(job,result.nonce))>=job.target)throw new Error('Invalid engine proof');
      const proof={...job,nonce:result.nonce,hash:result.hash,transaction:transaction(job,result.nonce,chain.contract,chain.chain.id)};
      const proofPath=await saveArtifact(output,'proof',proof);
      log({event:'solution',path:proofPath,nonce:result.nonce,hash:result.hash});
      if(!submit) return {hashes,accepted,proofPath};
      let prepared;
      try {prepared=await chain.prepare(job,result.nonce,limits);}
      catch(e){log({event:'discarded',reason:e.shortMessage??e.message});latest=await chain.snapshot(miner);continue;}
      if(signal.aborted)break;
      const serialized=await chain.sign(prepared,account);
      const txHash=keccak256(serialized);
      // Record the exact signed bytes BEFORE broadcast. Never automatically sign
      // another mint after an ambiguous send/receipt failure.
      const journal=await saveArtifact(output,'signed-transaction',{hash:txHash,serialized,proofPath,transaction:prepared.tx});
      if(signal.aborted)break;
      log({event:'broadcasting',hash:txHash,journal});
      try {
        const sent=await chain.client.sendRawTransaction({serializedTransaction:serialized});
        if(sent.toLowerCase()!==txHash.toLowerCase())throw new Error('RPC returned unexpected transaction hash');
        const receipt=await chain.client.waitForTransactionReceipt({hash:txHash,confirmations:1,timeout:120000});
        await saveArtifact(output,'receipt',receipt);
        if(receipt.status!=='success') throw new Error(`Mint reverted: ${txHash}`);
        accepted++;log({event:'minted',hash:txHash,accepted});
      } catch(e) {
        throw new Error(`Submission stopped. Check transaction ${txHash} before restarting. Journal: ${journal}. ${e.shortMessage??e.message}`);
      }
      if(accepted>=maxMints)break;
      latest=await chain.snapshot(miner);
    }
    return {hashes,accepted};
  } finally {polling=false;await pollPromise;log({event:'stopped',hashes,accepted});}
}
