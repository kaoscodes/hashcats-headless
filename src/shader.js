// Keccak-f[1600], generated scalar state avoids dynamically indexed GPU registers.
// Each vec2 holds either low/high halves or even/odd bits of a 64-bit lane.
const rotations = [0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14];
export function interleave(lo,hi) {
  let even=0,odd=0;
  for(let i=0;i<16;i++){even |= ((lo >>> (2*i))&1)<<i; odd |= ((lo >>> (2*i+1))&1)<<i;
    even |= ((hi >>> (2*i))&1)<<(i+16); odd |= ((hi >>> (2*i+1))&1)<<(i+16);}
  return [even>>>0,odd>>>0];
}
function constants(kernel) {
  let lfsr = 1;
  return Array.from({ length: 24 }, () => {
    let rc = 0n;
    for (let j = 0; j < 7; j++) {
      if (lfsr & 1) rc ^= 1n << BigInt((1 << j) - 1);
      lfsr = ((lfsr << 1) ^ ((lfsr & 128) ? 0x71 : 0)) & 255;
    }
    const lo=Number(rc & 0xffffffffn),hi=Number(rc >> 32n);
    const [a,b]=kernel==='interleaved'?interleave(lo,hi):[lo,hi];
    return `vec2<u32>(0x${a.toString(16)}u, 0x${b.toString(16)}u)`;
  });
}
function rot(v, n) {
  if (n === 0) return v;
  if (n === 32) return `${v}.yx`;
  if (n > 32) return rot(`${v}.yx`, n - 32);
  return `((${v} << vec2<u32>(${n}u)) | (${v}.yx >> vec2<u32>(${32-n}u)))`;
}
function rotInterleaved(v,n) {
  if(n===0)return v;
  if(n%2===0){const r=n/2;return `((${v} << vec2<u32>(${r}u)) | (${v} >> vec2<u32>(${32-r}u)))`;}
  const half=(n-1)/2;
  const r=(x,b)=>b===0?x:`((${x} << ${b}u) | (${x} >> ${32-b}u))`;
  return `vec2<u32>(${r(`${v}.y`,half+1)}, ${r(`${v}.x`,half)})`;
}
export function shader(workgroup = 64, kernel = 'interleaved') {
  const rotation=kernel==='interleaved'?rotInterleaved:rot;
  const init = Array.from({length:25}, (_,i) => `var a${i} = ${i<17 ? `vec2<u32>(job[${2*i}],job[${2*i+1}])` : 'vec2<u32>(0u)'};`).join('\n');
  const theta = Array.from({length:5},(_,x)=>`let c${x} = ${Array.from({length:5},(_,y)=>`a${x+5*y}`).join(' ^ ')};`).join('\n') + '\n' +
    Array.from({length:5},(_,x)=>`let d${x} = c${(x+4)%5} ^ ${rotation(`c${(x+1)%5}`,1)};`).join('\n');
  const rho = Array.from({length:25},(_,i)=> {
    const x=i%5,y=Math.floor(i/5),dest=y+5*((2*x+3*y)%5);
    return `let t${i} = a${i} ^ d${x}; let b${dest} = ${rotation(`t${i}`,rotations[i])};`;
  }).join('\n');
  const chi = Array.from({length:25},(_,i)=> {
    const x=i%5,row=i-x;
    return `a${i} = b${i} ^ ((~b${row+(x+1)%5}) & b${row+(x+2)%5});`;
  }).join('\n');
  const hashWords = Array.from({length:8},(_,i)=>kernel==='interleaved'?`swap(spread(a${Math.floor(i/2)}.x ${i%2?'>> 16u':''}) | (spread(a${Math.floor(i/2)}.y ${i%2?'>> 16u':''}) << 1u))`:`swap(a${Math.floor(i/2)}.${i%2?'y':'x'})`);
  return `
const RC = array<vec2<u32>,24>(${constants(kernel).join(',')});
@group(0) @binding(0) var<storage,read> job: array<u32>;
@group(0) @binding(1) var<storage,read_write> winner: atomic<u32>;
@group(0) @binding(2) var<storage,read_write> hashes: array<u32>;
fn swap(x:u32)->u32 { return ((x & 255u)<<24u) | ((x & 65280u)<<8u) | ((x>>8u)&65280u) | (x>>24u); }
fn compact(input:u32)->u32 {
 var x=input & 0x55555555u; x=(x | (x>>1u)) & 0x33333333u;
 x=(x | (x>>2u)) & 0x0f0f0f0fu; x=(x | (x>>4u)) & 0x00ff00ffu;
 return (x | (x>>8u)) & 0x0000ffffu;
}
fn spread(input:u32)->u32 {
 var x=input & 0xffffu; x=(x | (x<<8u)) & 0x00ff00ffu;
 x=(x | (x<<4u)) & 0x0f0f0f0fu; x=(x | (x<<2u)) & 0x33333333u;
 return (x | (x<<1u)) & 0x55555555u;
}
@compute @workgroup_size(${workgroup})
fn main(@builtin(global_invocation_id) gid:vec3<u32>) {
 if (gid.x >= (job[43]-1u)/job[44]+1u) { return; }
 let start = gid.x * job[44];
 for (var step=0u; step<job[44]; step++) {
  if (step >= job[43]-start) { return; }
  let offset = start + step;
  ${init}
  ${kernel==='interleaved'?`let counter=swap(job[42]+offset);
  a6 = (a6 & vec2<u32>(0xffff0000u)) | vec2<u32>(compact(counter),compact(counter>>1u));`:
  'a6.x = swap(job[42] + offset);'}
  for(var round=0u; round<24u; round++) {
   ${theta}
   ${rho}
   ${chi}
   a0 ^= RC[round];
  }
  ${hashWords.map((v,i)=>`let h${i} = ${v};`).join('\n')}
  if (job[45] != 0u) { ${hashWords.map((_,i)=>`hashes[offset*8u+${i}u]=h${i};`).join(' ')} }
  var less = false;
  var equal = true;
  ${hashWords.map((_,i)=>`less = less || (equal && h${i}<job[${34+i}]); equal = equal && h${i}==job[${34+i}];`).join('\n')}
  if (less) { atomicMin(&winner,offset); }
 }
}`;
}
