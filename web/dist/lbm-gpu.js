import { shader, postShader } from './lbm-shaders.js';
export { C, W } from './lbm-shaders.js';

export class GPULBM {
  static async create(config) {
    if (!navigator.gpu)
      throw new Error(
        'このブラウザはWebGPUに対応していません。WebGPU対応のChrome / Edge / Safariなどで開いてください。',
      );
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter)
      throw new Error(
        'GPUを利用できません。ブラウザのグラフィックアクセラレーションを確認してください。',
      );
    const n = config.nx * config.ny * config.nz,
      bytes = n * 19 * 4;
    if (bytes > adapter.limits.maxStorageBufferBindingSize || bytes > adapter.limits.maxBufferSize)
      throw new Error('GPUメモリの上限を超えます。格子を「粗い」に変更してください。');
    const device = await adapter.requestDevice({
      requiredLimits: {
        maxStorageBufferBindingSize: Math.max(134217728, bytes),
        maxBufferSize: Math.max(268435456, bytes),
      },
    });
    const solver = new GPULBM(device, config);
    try {
      await solver.setup();
      return solver;
    } catch (error) {
      solver.destroy();
      throw error;
    }
  }
  constructor(device, config) {
    this.device = device;
    this.config = config;
    this.resources = [];
    this.stepCount = 0;
    this.current = 0;
    this.failed = null;
    device.lost.then((info) => {
      if (info.reason !== 'destroyed')
        this.failed = new Error('GPUとの接続が切れました。格子を粗くして再計算してください。');
    });
    device.addEventListener('uncapturederror', (event) => {
      this.failed = event.error;
    });
  }
  buffer(size, usage) {
    const b = this.device.createBuffer({ size, usage });
    this.resources.push(b);
    return b;
  }
  async setup() {
    const d = this.device,
      c = this.config,
      n = c.nx * c.ny * c.nz;
    this.n = n;
    this.groups = Math.ceil(n / 128);
    const U = GPUBufferUsage;
    this.params = this.buffer(80, U.UNIFORM | U.COPY_DST);
    const data = new ArrayBuffer(80);
    new Uint32Array(data).set([c.nx, c.ny, c.nz, n]);
    new Float32Array(data).set(
      [
        c.cx,
        c.cy,
        c.cz,
        c.d / 2,
        c.u,
        c.tau,
        c.cs,
        0,
        ...c.omega,
        0,
        c.mode ?? 0,
        c.seed ?? 7,
        0,
        0,
      ],
      4,
    );
    d.queue.writeBuffer(this.params, 0, data);
    this.pop = [0, 1].map(() => this.buffer(n * 19 * 4, U.STORAGE));
    this.cells = this.buffer(n * 48, U.STORAGE | U.COPY_SRC);
    this.sliceLength = c.nx * c.ny + c.nx * c.nz + c.ny * c.nz;
    this.slices = this.buffer(this.sliceLength * 16, U.STORAGE | U.COPY_SRC);
    this.stats = this.buffer(this.groups * 48, U.STORAGE | U.COPY_SRC);
    this.readback = this.buffer(this.sliceLength * 16 + this.groups * 48, U.MAP_READ | U.COPY_DST);
    d.pushErrorScope('validation');
    const module = d.createShaderModule({ code: shader }),
      post = d.createShaderModule({ code: postShader });
    const messages = [
      ...(await module.getCompilationInfo()).messages,
      ...(await post.getCompilationInfo()).messages,
    ].filter((m) => m.type === 'error');
    if (messages.length) {
      this.destroy();
      throw new Error(
        'CFDシェーダーのコンパイルに失敗: ' +
          messages.map((m) => `${m.lineNum}: ${m.message}`).join('\n'),
      );
    }
    // Shared explicit layout keeps init/step bind groups interchangeable.
    const layout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ...['read-only-storage', 'storage', 'storage'].map((type, i) => ({
          binding: i + 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type },
        })),
      ],
    });
    const pl = d.createPipelineLayout({ bindGroupLayouts: [layout] });
    this.initPipeline = await d.createComputePipelineAsync({
      layout: pl,
      compute: { module, entryPoint: 'initialize' },
    });
    this.pipeline = await d.createComputePipelineAsync({
      layout: pl,
      compute: { module, entryPoint: 'step' },
    });
    this.binds = [0, 1].map((i) =>
      d.createBindGroup({
        layout,
        entries: [this.params, this.pop[i], this.pop[1 - i], this.cells].map((buffer, binding) => ({
          binding,
          resource: { buffer },
        })),
      }),
    );
    const postLayout = d.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        ...['read-only-storage', 'storage', 'storage'].map((type, i) => ({
          binding: i + 1,
          visibility: GPUShaderStage.COMPUTE,
          buffer: { type },
        })),
      ],
    });
    const ppl = d.createPipelineLayout({ bindGroupLayouts: [postLayout] });
    this.reduce = await d.createComputePipelineAsync({
      layout: ppl,
      compute: { module: post, entryPoint: 'reduce' },
    });
    this.slice = await d.createComputePipelineAsync({
      layout: ppl,
      compute: { module: post, entryPoint: 'slice' },
    });
    this.postBind = d.createBindGroup({
      layout: postLayout,
      entries: [this.params, this.cells, this.slices, this.stats].map((buffer, binding) => ({
        binding,
        resource: { buffer },
      })),
    });
    const error = await d.popErrorScope();
    if (error) {
      this.destroy();
      throw new Error(error.message);
    }
    const encoder = d.createCommandEncoder(),
      pass = encoder.beginComputePass();
    pass.setPipeline(this.initPipeline);
    pass.setBindGroup(0, this.binds[1]);
    pass.dispatchWorkgroups(this.groups);
    pass.end();
    d.queue.submit([encoder.finish()]);
    await d.queue.onSubmittedWorkDone();
  }
  async advance(count) {
    if (this.failed) throw this.failed;
    const d = this.device,
      e = d.createCommandEncoder();
    for (let i = 0; i < count; i++) {
      const pass = e.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.binds[this.current]);
      pass.dispatchWorkgroups(this.groups);
      pass.end();
      this.current = 1 - this.current;
    }
    d.queue.submit([e.finish()]);
    await d.queue.onSubmittedWorkDone();
    this.stepCount += count;
    if (this.failed) throw this.failed;
  }
  async snapshot() {
    if (this.failed) throw this.failed;
    const d = this.device,
      e = d.createCommandEncoder();
    for (const [pipeline, groups] of [
      [this.reduce, this.groups],
      [this.slice, Math.ceil(this.sliceLength / 128)],
    ]) {
      const pass = e.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, this.postBind);
      pass.dispatchWorkgroups(groups);
      pass.end();
    }
    const offset = this.sliceLength * 16;
    e.copyBufferToBuffer(this.slices, 0, this.readback, 0, offset);
    e.copyBufferToBuffer(this.stats, 0, this.readback, offset, this.groups * 48);
    d.queue.submit([e.finish()]);
    await this.readback.mapAsync(GPUMapMode.READ);
    const data = new Float32Array(this.readback.getMappedRange());
    const fields = data.slice(0, this.sliceLength * 4),
      stats = data.subarray(this.sliceLength * 4);
    const s = {
      rhoMin: Infinity,
      rhoMax: -Infinity,
      maxMa: 0,
      maxNu: 0,
      mass: 0,
      limited: 0,
      invalid: 0,
      count: 0,
      force: [0, 0, 0],
    };
    for (let i = 0; i < stats.length; i += 12) {
      s.rhoMin = Math.min(s.rhoMin, stats[i]);
      s.rhoMax = Math.max(s.rhoMax, stats[i + 1]);
      s.maxMa = Math.max(s.maxMa, stats[i + 2]);
      s.maxNu = Math.max(s.maxNu, stats[i + 3]);
      s.mass += stats[i + 4];
      s.limited += stats[i + 5];
      s.invalid += stats[i + 6];
      s.count += stats[i + 7];
      for (let k = 0; k < 3; k++) s.force[k] += stats[i + 8 + k];
    }
    this.readback.unmap();
    s.meanRho = s.mass / s.count;
    if (!Number.isFinite(s.meanRho) || !Number.isFinite(s.maxMa) || s.invalid > 0 || s.maxMa > 0.18)
      throw new Error(
        '数値的な不安定を検出したため計算を停止しました。格子を細かくするか回転・速度を調整してください。',
      );
    return { step: this.stepCount, fields, stats: s };
  }
  async readCells() {
    // Small-domain numerical verification only.
    const b = this.buffer(this.n * 48, GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST),
      e = this.device.createCommandEncoder();
    e.copyBufferToBuffer(this.cells, 0, b, 0, this.n * 48);
    this.device.queue.submit([e.finish()]);
    await b.mapAsync(GPUMapMode.READ);
    const result = new Float32Array(b.getMappedRange()).slice();
    b.unmap();
    return result;
  }
  destroy() {
    for (const b of this.resources) b.destroy();
    this.device.destroy();
  }
}
