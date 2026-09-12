import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createState, updateState, renderDashboard, estimates } from '../src/dashboard.js';
import { createReporter } from '../src/reporter.js';

const target=(2n**256n-1n)/2n**48n;
const tx='0x'+'ab'.repeat(32);
const event=(state,e,time=1000)=>updateState(state,e,time);

test('ETA uses full wallet target and does not count down as unsuccessful mining time elapses',()=>{
  const result=estimates(target,3.18e9);
  assert.ok(Math.abs(result.seconds/3600-24.587262)<0.001);
  assert.ok(Math.abs(result.perDay-0.976115)<0.000001);
  assert.equal(estimates(0n,3.18e9).seconds,Infinity);
  const state=createState(1000);
  event(state,{event:'job',target,price:1n,receivedAt:1000},1000);
  event(state,{event:'progress',hashes:3.18e9*3600,hashrate:3.18e9,elapsedSeconds:3600},3601000);
  const first=renderDashboard(state,{now:3601000,width:120,height:30});
  event(state,{event:'progress',hashes:3.18e9*7200,hashrate:3.18e9,elapsedSeconds:7200},7201000);
  const second=renderDashboard(state,{now:7201000,width:120,height:30});
  assert.match(first,/Mean ETA \/ proof 1d 0h/);
  assert.equal(first.match(/Mean ETA.*$/m)[0],second.match(/Mean ETA.*$/m)[0]);
});

test('confirmed mints, discarded proofs, reversions and unknown transactions stay distinct and visible after stop',()=>{
  const state=createState();
  event(state,{event:'session',submit:true,maxMints:3});
  event(state,{event:'solution'});
  event(state,{event:'discarded',reason:'Stale proof: another cat was minted'});
  event(state,{event:'progress',hashes:100,hashrate:10,elapsedSeconds:10});
  assert.match(state.lastProblem.message,/Stale proof/);
  event(state,{event:'solution'});
  event(state,{event:'broadcasting',hash:tx});
  event(state,{event:'minted',accepted:1,hash:tx,price:100n,gasCost:20n});
  event(state,{event:'solution'});
  event(state,{event:'submission-failed',outcome:'reverted',hash:tx,message:'receipt reverted'});
  event(state,{event:'solution'});
  event(state,{event:'submission-failed',outcome:'unknown',hash:tx,message:'receipt timeout'});
  event(state,{event:'stopped',hashes:100,accepted:1,elapsedSeconds:10});
  event(state,{event:'error',message:'Submission stopped. Check transaction.'});
  const screen=renderDashboard(state,{width:100,height:30});
  assert.match(screen,/1 CAT MINTED THIS SESSION/);
  assert.match(screen,/Proofs found 4/);
  assert.match(screen,/Discarded 1.*Reverted 1.*Unknown TX 1.*Errors 1/);
  assert.match(screen,/receipt timeout/);
  assert.equal(state.spent,120n);
});

test('dashboard handles resizing, stale balances and terminal escape sequences from RPC errors',()=>{
  const state=createState(1000);
  event(state,{event:'wallet',balance:10n**18n,receivedAt:1000});
  event(state,{event:'error',message:'bad RPC\x1b[2J\nline'});
  for(const [width,height] of [[40,16],[80,24],[120,40]]) {
    const screen=renderDashboard(state,{now:61000,width,height});
    assert.ok(screen.split('\n').length<=height-1);
    assert.ok(screen.split('\n').every(line=>line.length<=width-1));
    assert.ok(!screen.includes('\x1b'));
    assert.match(screen,/LAST PROBLEM/);
  }
  assert.match(renderDashboard(state,{now:61000,width:100,height:30}),/STALE/);
});

test('reporter keeps timestamped restricted JSONL logs while rendering a non-scrolling dashboard and restoring the cursor',()=>{
  const dir=mkdtempSync(join(tmpdir(),'hashcats-report-'));
  const output=[];
  const stream={columns:100,rows:30,write:value=>output.push(value)};
  try {
    const reporter=createReporter({tui:true,output:dir,stream,now:()=>1000});
    reporter.log({event:'session',miner:'0x123',submit:true,maxMints:1});
    reporter.log({event:'wallet',balance:123n,receivedAt:1000});
    reporter.log({event:'submission-failed',outcome:'unknown',hash:tx,message:'timeout'});
    reporter.log({event:'error',message:'Check transaction before restarting'});
    reporter.close();
    const records=readFileSync(reporter.path,'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length,4);
    assert.equal(records[1].balance,'123');
    assert.equal(records[0].timestamp,'1970-01-01T00:00:01.000Z');
    assert.equal(statSync(reporter.path).mode&0o777,0o600);
    assert.ok(!output.join('').includes('event=wallet'));
    assert.ok(output.at(-1).includes('\x1b[?25h'));
    assert.throws(()=>createReporter({logFile:reporter.path}),/EEXIST/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('JSON output remains machine-readable and includes the same events as the separate log',()=>{
  const dir=mkdtempSync(join(tmpdir(),'hashcats-json-'));
  const output=[];
  try {
    const reporter=createReporter({jsonLines:true,output:dir,stream:{write:v=>output.push(v)}});
    reporter.log({event:'work',price:10n,target:target,receivedAt:123});
    reporter.close();
    assert.equal(output.join(''),readFileSync(reporter.path,'utf8'));
    assert.equal(JSON.parse(output[0]).price,'10');
    assert.ok(!output.join('').includes('\x1b'));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('multi-GPU dashboard shows per-card rates, failures and a small-terminal overflow indicator',()=>{
  const state=createState(1000);
  const gpus=Array.from({length:8},(_,index)=>({index,name:'Identical GPU',hashes:3e10,hashrate:3e9,status:index===1?'FAILED':'MINING'}));
  event(state,{event:'device',device:'8 Vulkan GPUs',gpus});
  event(state,{event:'job',target,price:1n,receivedAt:1000},1000);
  event(state,{event:'progress',hashes:24e10,hashrate:24e9,elapsedSeconds:10,gpus},11000);
  const full=renderDashboard(state,{now:11000,width:120,height:40});
  assert.match(full,/GPU 0.*3.00 GH\/s/);
  assert.match(full,/GPU 1.*FAILED/);
  assert.match(full,/GPU 7/);
  const compact=renderDashboard(state,{now:11000,width:80,height:24});
  assert.match(compact,/enlarge terminal/);
  assert.ok(compact.split('\n').length<=23);
});
