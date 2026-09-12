import { mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname, resolve, join, relative } from 'node:path';
import { randomUUID } from 'node:crypto';
import { json } from './proof.js';
import { createState, updateState, renderDashboard } from './dashboard.js';

export function createReporter({tui=false,jsonLines=false,logFile,output='results',stream=process.stdout,now=Date.now}={}) {
  const path=resolve(logFile??join(output,`miner-${new Date(now()).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}/,'')}-${randomUUID().slice(0,8)}.jsonl`));
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  // Never overwrite an earlier run or follow a pre-existing log-file symlink.
  const fd=openSync(path,'wx',0o600);
  const state=createState(now());
  const localPath=relative(process.cwd(),path);
  state.logPath=localPath.startsWith('..')?path:localPath;
  let closed=false,timer;
  function render() {
    const screen=renderDashboard(state,{now:now(),width:stream.columns??100,height:stream.rows??30});
    const color=(line,index)=>{
      if(process.env.NO_COLOR!==undefined)return line;
      let code;
      if(index===0)code='1;36';
      if(index===1)code=state.errors||state.unknown||state.reverted?'1;31':state.status==='PAUSED'?'1;33':'1';
      if(index===2)code=state.accepted?'1;32':'1;33';
      if(index===3&&(state.discarded||state.reverted||state.unknown||state.errors))code='1;31';
      if(index===4&&state.lastProblem)code='33';
      return code?`\x1b[${code}m${line}\x1b[0m`:line;
    };
    stream.write('\x1b[H'+screen.split('\n').map((line,i)=>color(line,i)+'\x1b[K').join('\n')+'\x1b[J');
  }
  if(tui) {
    stream.write('\x1b[2J\x1b[H\x1b[?25l');
    render();timer=setInterval(render,1000);timer.unref();
  }
  return {
    state,path,
    log(event) {
      if(closed)return;
      const time=now();
      const record={...event,timestamp:new Date(time).toISOString()};
      // Preserve the final on-screen outcome even if the log disk becomes full.
      updateState(state,event,time);
      writeSync(fd,json(record)+'\n');
      if(!tui)stream.write((jsonLines?json(record):Object.entries(record).map(([k,v])=>`${k}=${typeof v==='object'?json(v):v}`).join(' '))+'\n');
      else if(!['progress','work','wallet'].includes(event.event))render();
    },
    close() {
      if(closed)return;
      closed=true;clearInterval(timer);
      try {if(tui){render();stream.write('\x1b[?25h\n');}}
      finally {closeSync(fd);}
    },
  };
}
