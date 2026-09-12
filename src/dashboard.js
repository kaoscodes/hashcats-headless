import { formatEther } from 'viem';

const clean = value => String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ');
const short = (value, width) => {
  const text = clean(value);
  return text.length > width ? text.slice(0, Math.max(0, width - 3)) + '...' : text;
};
export function duration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}
export function hashrate(value) {
  if (!(value > 0)) return '--';
  for (const [scale, unit] of [[1e12,'TH/s'],[1e9,'GH/s'],[1e6,'MH/s'],[1e3,'kH/s'],[1,'H/s']]) {
    if (value >= scale) return `${(value / scale).toFixed(2)} ${unit}`;
  }
  return `${value.toFixed(2)} H/s`;
}
export function estimates(target, rate) {
  if (!target || BigInt(target) <= 0n || !(rate > 0)) return {seconds:Infinity,perDay:0};
  const expectedHashes = 2 ** 256 / Number(target);
  return {seconds:expectedHashes / rate,perDay:rate * 86400 / expectedHashes};
}
const eth = value => value === undefined || value === null ? '--' : `${Number(formatEther(BigInt(value))).toFixed(6)} ETH`;
const clock = time => new Date(time).toISOString().slice(11,19) + ' UTC';

export function createState(now = Date.now()) {
  return {startedAt:now,status:'STARTING',hashes:0,rate:0,accepted:0,found:0,discarded:0,reverted:0,unknown:0,
    errors:0,rpcErrors:0,pauses:0,spent:0n,history:[],lastProblem:null,finishedAt:null};
}
export function updateState(s, e, now = Date.now()) {
  const add = message => {s.history.push({time:now,message});s.history=s.history.slice(-5);};
  const problem = message => {s.lastProblem={time:now,message};add(message);};
  switch(e.event) {
    case 'session': Object.assign(s,{miner:e.miner,submit:e.submit,maxMints:e.maxMints,maxPrice:e.maxPrice,maxAgeMs:e.maxAgeMs});break;
    case 'device': s.device=e.device ?? e.engine ?? 'CPU';break;
    case 'job': s.miningAt=now;s.status='MINING'; // falls through
    case 'work': Object.assign(s,{target:e.target,price:e.price,anchorBlock:e.anchorBlock,workAt:e.receivedAt});break;
    case 'wallet': s.balance=e.balance;s.balanceAt=e.receivedAt;s.balanceError=null;break;
    case 'wallet-error': s.balanceError=e.message;s.rpcErrors++;problem(`Balance refresh failed: ${e.message}`);break;
    case 'rpc-error': s.rpcErrors++;s.rpcError=e.message;problem(`RPC: ${e.message}`);break;
    case 'rpc-restored': s.rpcError=null;add('Chain RPC recovered');break;
    case 'progress':
      s.hashes=e.hashes;s.rate=e.hashrate;s.elapsedSeconds=e.elapsedSeconds;s.progressAt=now;
      s.status='MINING';break;
    case 'paused': if(s.status!=='PAUSED')s.pauses++;s.status='PAUSED';s.rate=0;problem(`Mining paused: ${e.detail || e.reason}`);break;
    case 'solution': s.found++;s.status=s.submit?'VERIFYING PROOF':'PROOF SAVED';s.lastProof=e.path;add('Valid proof found');break;
    case 'discarded': s.discarded++;s.status='MINING';problem(`Proof discarded: ${e.reason}`);break;
    case 'signing': s.status='SIGNING';break;
    case 'broadcasting': s.status='AWAITING RECEIPT';s.lastTx=e.hash;s.pending=true;add(`Broadcasting transaction: ${e.hash}`);break;
    case 'submission-failed':
      if(e.outcome==='reverted')s.reverted++;else s.unknown++;
      s.pending=false;s.status=e.outcome==='reverted'?'MINT REVERTED':'TRANSACTION STATUS UNKNOWN';
      s.lastTx=e.hash;problem(`${s.status}: ${e.message}`);break;
    case 'minted':
      s.accepted=e.accepted;s.pending=false;s.status='MINT CONFIRMED';s.lastTx=e.hash;s.lastMintAt=now;
      s.spent+=BigInt(e.price??0)+BigInt(e.gasCost??0);add(`Cat #${e.accepted} confirmed: ${e.hash}`);break;
    case 'stopped':
      s.hashes=e.hashes;s.accepted=e.accepted;s.finishedAt=now;s.rate=0;
      if(e.elapsedSeconds!==undefined)s.elapsedSeconds=e.elapsedSeconds;
      if(!['MINT REVERTED','TRANSACTION STATUS UNKNOWN','ERROR'].includes(s.status))
        s.status=s.submit&&s.accepted>=s.maxMints?'COMPLETE':!s.submit&&s.found?'PROOF SAVED':'STOPPED';
      break;
    case 'error':
      s.errors++;s.status='ERROR';s.finishedAt=now;s.rate=0;
      if((s.unknown||s.reverted)&&s.lastProblem)add(e.message);else problem(e.message);
      break;
  }
  return s;
}

export function renderDashboard(s, {now=Date.now(),width=100,height=30}={}) {
  width=Math.max(20,Math.min(140,width-1));
  height=Math.max(5,height-1);
  const elapsed=s.finishedAt?s.elapsedSeconds??0:s.miningAt?Math.max(0,(now-s.miningAt)/1000):0;
  const average=elapsed>0?s.hashes/elapsed:0;
  const estimate=estimates(s.target,average);
  const liveRate=s.status==='MINING' && now-(s.progressAt??now)<5000?s.rate:0;
  const age=s.workAt?(now-s.workAt)/1000:null;
  const balanceAge=s.balanceAt?(now-s.balanceAt)/1000:null;
  const stale=age!==null&&age*1000>(s.maxAgeMs??3000);
  let warning=s.lastProblem?`${clock(s.lastProblem.time)} ${s.lastProblem.message}`:'None recorded';
  if(s.submit&&s.price!==undefined&&s.maxPrice!==undefined&&BigInt(s.price)>BigInt(s.maxPrice))
    warning=`PRICE ABOVE CEILING: proofs cannot be submitted. ${warning}`;
  if(s.submit&&s.balance!==undefined&&s.price!==undefined&&BigInt(s.balance)<BigInt(s.price))
    warning=`LOW BALANCE: below current mint price, before gas. ${warning}`;
  const result=s.accepted>0?`${s.accepted} CAT${s.accepted===1?'':'S'} MINTED THIS SESSION`:'NO CATS MINTED THIS SESSION';
  const lines=[
    'HASHCATS / LIVE MINER',
    `${s.status}  |  Runtime ${duration(((s.finishedAt??now)-s.startedAt)/1000)}  |  ${s.submit?'AUTO MINT':'PROOF ONLY'}`,
    `${result}  |  Goal ${s.submit?s.maxMints??'--':'--'}  |  Proofs found ${s.found}`,
    `Discarded ${s.discarded}  |  Reverted ${s.reverted}  |  Unknown TX ${s.unknown}  |  Errors ${s.errors}`,
    `LAST PROBLEM: ${short(warning,width-14)}`,
    '-'.repeat(width),
    `Hashrate ${hashrate(liveRate)}  |  Average ${hashrate(average)}  |  Hashes ${s.hashes.toLocaleString('en-US')}`,
    `Mean ETA / proof ${duration(estimate.seconds)}  |  Expected proofs/day ${estimate.perDay?estimate.perDay.toLocaleString('en-US',{maximumSignificantDigits:3}):'--'}`,
    'ETA is a statistical mean, not a countdown or a guaranteed mint.',
    `Balance ${eth(s.balance)}  |  ${s.balanceError?'REFRESH FAILED':balanceAge===null?'Fetching...':`Updated ${duration(balanceAge)} ago${balanceAge>45?' (STALE)':''}`}`,
    `Mint price ${eth(s.price)}  |  Ceiling ${eth(s.maxPrice)}`,
    `Confirmed spend ${eth(s.spent)} incl. gas (excludes reverted/unknown TXs)`,
    `Wallet ${s.miner??'Loading...'}`,
    `Anchor ${s.anchorBlock??'--'}  |  Work age ${age===null?'--':duration(age)}${stale?' STALE':''}  |  RPC warnings ${s.rpcErrors}  |  Pauses ${s.pauses}`,
    `Last mint ${s.lastMintAt?clock(s.lastMintAt):'None this session'}  |  ${s.pending?'TX PENDING - do not restart':'Receipt-confirmed count only'}`,
    `Last TX ${s.lastTx??'--'}`,
  ];
  // Reserve the footer, even in a short terminal. Core outcome and failures stay first.
  const footer=[`Log ${s.logPath??'--'}`,s.finishedAt?'Session ended. Review problems and transaction status before restarting.':'Ctrl+C stop  |  tmux: Ctrl+B then D detach  |  Times shown in UTC'];
  const room=Math.max(0,height-footer.length-lines.length);
  const extra=[`GPU ${s.device??'Initializing...'}`,
    ...s.history.slice(-Math.max(0,room-1)).map(e=>`${clock(e.time)} ${e.message}`)];
  const visible=[...lines,...extra.slice(0,room)].slice(0,Math.max(0,height-footer.length));
  return [...visible,...footer].map(line=>short(line,width)).join('\n');
}
