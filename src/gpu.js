import { inputBytes, uint256, nonceAt, workHash } from './proof.js';
import { shader, interleave } from './shader.js';

export class GpuMiner {
  static async create({ backend, adapter: adapterName, workgroup = 64, perThread = 16, kernel = 'interleaved' } = {}) {
    if (!['split','interleaved'].includes(kernel)) throw new Error('Invalid GPU kernel');
    if (![64,128,256].includes(workgroup) || !Number.isInteger(perThread) || perThread < 1 || perThread > 1024)
      throw new Error('Invalid GPU workgroup or per-thread setting');
    const { create, globals } = await import('webgpu');
    Object.assign(globalThis, globals);
    const options = [];
    if (backend) options.push(`backend=${backend}`);
    if (adapterName) options.push(`adapter=${adapterName}`);
    const gpu = create(options);
    const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('No hardware WebGPU adapter. Check GPU drivers, backend and adapter selection.');
    const info = adapter.info;
    if (info.isFallbackAdapter || /swiftshader|llvmpipe|lavapipe|software|warp/i.test(`${info.vendor} ${info.description} ${info.device}`))
      throw new Error('Software GPU rejected; select a hardware adapter or --engine cpu');
    const device = await adapter.requestDevice();
    const miner = new GpuMiner();
    Object.assign(miner, { gpu, device, perThread, workgroup, kernel, info: {vendor:info.vendor, architecture:info.architecture, device:info.device, description:info.description} });
    device.lost.then(info => { if (info.reason !== 'destroyed') miner.failure = new Error(`GPU lost: ${info.message}`); });
    device.addEventListener('uncapturederror', e => { miner.failure = new Error(e.error.message); });
    try {
      device.pushErrorScope('validation');
      const module = device.createShaderModule({ code: shader(workgroup,kernel) });
      const compilation = await module.getCompilationInfo();
      const errors = compilation.messages.filter(m => m.type === 'error');
      if (errors.length) throw new Error(errors.map(m => `${m.lineNum}: ${m.message}`).join('\n'));
      miner.pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } });
      const error = await device.popErrorScope();
      if (error) throw new Error(error.message);
      miner.jobBuffer = device.createBuffer({ size: 184, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      miner.resultBuffer = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
      miner.readBuffer = device.createBuffer({ size: 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      miner.dumpBuffer = device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
      const probe = { miner:'0x1234567890123456789012345678901234567890', prev:42n,
        anchor:'0x'+'ab'.repeat(32), target:0n };
      const check = await miner.batch(probe, 0n, 0xfffffff0, 16, {dump:true});
      if (check.nonce !== null || check.hashes.some((h,i) => h !== workHash(probe, BigInt(0xfffffff0+i))))
        throw new Error('GPU startup hash verification failed');
      return miner;
    } catch (e) { miner.close(); throw e; }
  }
  async batch(job, prefix, base, count, { dump = false } = {}) {
    if (this.failure) throw this.failure;
    if (!Number.isInteger(count) || count < 1 || count > 0xffffffff || !Number.isInteger(base) || base < 0 || base + count > 2**32)
      throw new Error('Batch would overflow the 32-bit counter');
    nonceAt(prefix, base);
    const groups = Math.ceil(count / this.perThread / this.workgroup);
    if (groups > this.device.limits.maxComputeWorkgroupsPerDimension) throw new Error('Batch exceeds GPU dispatch limit');
    if (dump && count > 65536) throw new Error('Hash dump limited to 65536 nonces');
    const bytes = new Uint8Array(136);
    bytes.set(inputBytes(job, prefix)); bytes[116] = 1; bytes[135] = 128;
    const view = new DataView(bytes.buffer);
    const params = new Uint32Array(46);
    for (let i=0;i<34;i++) params[i] = view.getUint32(i*4,true);
    if(this.kernel==='interleaved')for(let i=0;i<34;i+=2)params.set(interleave(params[i],params[i+1]),i);
    const target = uint256(job.target);
    for (let i=0;i<8;i++) params[34+i] = Number((target >> BigInt((7-i)*32)) & 0xffffffffn);
    params.set([base,count,this.perThread,Number(dump)],42);
    const d = this.device;
    let dumpBuffer = this.dumpBuffer, dumpRead;
    if (dump) {
      dumpBuffer = d.createBuffer({size:count*32,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC});
      dumpRead = d.createBuffer({size:count*32,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    }
    try {
      d.queue.writeBuffer(this.jobBuffer,0,params);
      d.queue.writeBuffer(this.resultBuffer,0,new Uint32Array([0xffffffff]));
      const bind = d.createBindGroup({layout:this.pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:this.jobBuffer}}, {binding:1,resource:{buffer:this.resultBuffer}}, {binding:2,resource:{buffer:dumpBuffer}}
      ]});
      const encoder = d.createCommandEncoder();
      const pass = encoder.beginComputePass(); pass.setPipeline(this.pipeline); pass.setBindGroup(0,bind); pass.dispatchWorkgroups(groups); pass.end();
      encoder.copyBufferToBuffer(this.resultBuffer,0,this.readBuffer,0,4);
      if (dump) encoder.copyBufferToBuffer(dumpBuffer,0,dumpRead,0,count*32);
      d.queue.submit([encoder.finish()]);
      await this.readBuffer.mapAsync(GPUMapMode.READ);
      const index = new Uint32Array(this.readBuffer.getMappedRange())[0]; this.readBuffer.unmap();
      let hashes;
      if (dump) {
        await dumpRead.mapAsync(GPUMapMode.READ);
        const words = new Uint32Array(dumpRead.getMappedRange());
        hashes = Array.from({length:count},(_,n)=>'0x'+Array.from(words.subarray(n*8,n*8+8),v=>v.toString(16).padStart(8,'0')).join(''));
        dumpRead.unmap();
      }
      if (this.failure) throw this.failure;
      const nonce = index === 0xffffffff ? null : nonceAt(prefix,base+index);
      const hash = nonce === null ? null : workHash(job,nonce);
      if (nonce !== null && BigInt(hash) >= target) throw new Error('GPU proof failed independent CPU verification');
      return { count, nonce, hash, hashes };
    } finally { if (dump) { dumpBuffer.destroy(); dumpRead.destroy(); } }
  }
  close() { this.device?.destroy(); this.gpu = null; this.device = null; }
}
