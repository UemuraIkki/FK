import test from 'node:test';
import assert from 'node:assert/strict';
import { planeData, scalarAt, sliceCSV } from './dist/flow-field.js';
import { FlowRunner } from './dist/flow-runner.js';

const config = {
  nx: 5,
  ny: 7,
  nz: 9,
  cx: 2,
  cy: 3,
  cz: 4,
  d: 2,
  u: 0.02,
  dx: 0.11,
  dt: 0.00022,
  re: 300000,
  tau: 0.50001,
  cs: 0.16,
  steps: 101,
};
const condition = { speed: 10, flightTime: 0.25, omega: [0, 0, 2], diameter: 0.22 };
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} != ${b}`);

function frameWithSlices() {
  const size = config.nx * config.ny + config.nx * config.nz + config.ny * config.nz;
  const frame = { step: 101, fields: new Float32Array(size * 4) };
  for (const plane of ['xy', 'xz', 'yz']) {
    const p = planeData(frame, config, plane);
    for (let y = 0; y < p.h; y++)
      for (let x = 0; x < p.w; x++) {
        const i = (y * p.w + x) * 4;
        // In-plane solid-body rotation: exact curl = 2 * angular velocity.
        p.data[i + p.a] = -0.001 * y;
        p.data[i + p.b] = 0.001 * x;
        p.data[i + 3] = 1;
      }
  }
  return frame;
}

test('all three slice orientations recover the analytical curl on a non-cubic grid', () => {
  const frame = frameWithSlices();
  for (const [plane, width, height] of [
    ['xy', 5, 7],
    ['xz', 5, 9],
    ['yz', 7, 9],
  ]) {
    const p = planeData(frame, config, plane);
    assert.equal(p.w, width);
    assert.equal(p.h, height);
    close(scalarAt(p, 2 * p.w + 2, 'vorticity', config, condition), 0.2);
  }
});

test('SI velocity and Cp conversion; vorticity masks solids and adjacent cells', () => {
  const frame = frameWithSlices(),
    p = planeData(frame, config, 'xy'),
    i = 2 * p.w + 2;
  p.data.set([0.006, 0.008, 0, 1.0003], i * 4);
  close(scalarAt(p, i, 'speed', config, condition), 5);
  close(
    scalarAt(p, i, 'pressure', config, condition),
    (2 * (p.data[i * 4 + 3] - 1)) / (3 * 0.02 ** 2),
  );
  assert.equal(scalarAt(p, 0, 'vorticity', config, condition), undefined);
  p.data[(i + 1) * 4 + 3] = 0;
  assert.equal(scalarAt(p, i, 'vorticity', config, condition), undefined);
  assert.equal(scalarAt(p, i + 1, 'vorticity', config, condition), null);
});

test('CSV keeps SI units, plane coordinates, metadata, and blank unavailable derivatives', () => {
  const frame = frameWithSlices(),
    p = planeData(frame, config, 'yz'),
    solid = 2 * p.w + 3;
  p.data.fill(0, solid * 4, solid * 4 + 4);
  const csv = sliceCSV({ config, condition }, frame, 'yz'),
    lines = csv.split('\n');
  assert.equal(lines.length, p.w * p.h + 4);
  assert.match(lines[0], /plane=yz/);
  assert.match(lines[1], /flight_time_s=0.25/);
  const center = lines[4 + 2 * p.w + 2].split(',');
  close(Number(center[0]), -0.5);
  close(Number(center[1]), -1);
  assert.equal(center[6], ''); // adjacent to the solid, so curl is unavailable
  const masked = lines[4 + solid].split(',');
  assert.equal(masked[7], '1');
  assert.equal(masked[6], '');
  const clean = lines[4 + p.w + 1].split(',');
  close(Number(clean[3]), -0.5);
  close(Number(clean[4]), 0.5);
  close(Number(clean[6]), 0.2);
});

function fakeSolver({ failAt = Infinity } = {}) {
  return {
    stepCount: 0,
    destroyed: false,
    steps: [],
    async advance(n) {
      this.steps.push(n);
      this.stepCount += n;
      if (this.stepCount >= failAt) throw new Error('GPU test failure');
    },
    async snapshot() {
      return { step: this.stepCount, fields: new Float32Array([0, 0, 0, 1]) };
    },
    destroy() {
      this.destroyed = true;
    },
  };
}
const request = (key) => ({
  key,
  condition: structuredClone(condition),
  config: structuredClone(config),
});

test('a complete run reaches the exact final step, releases GPU resources, and bounds the cache', async () => {
  const solvers = [];
  let clock = 0;
  const runner = new FlowRunner({
    createSolver: async () => {
      const s = fakeSolver();
      solvers.push(s);
      return s;
    },
    now: () => (clock += 400),
  });
  const progress = [];
  for (const key of ['a', 'b', 'c']) {
    const result = await runner.run(request(key), { onProgress: (p) => progress.push(p) });
    assert.equal(result.complete, true);
    assert.equal(result.frames.at(-1).step, 101);
  }
  assert.deepEqual(solvers[0].steps, [32, 32, 32, 5]);
  assert.ok(solvers.every((s) => s.destroyed));
  assert.equal(runner.getCached('a'), undefined);
  assert.equal(runner.getCached('c').key, 'c');
  assert.equal(progress.at(-1).progress, 1);
  assert.equal(runner.running, false);
});

test('cancellation keeps partial frames without caching and allows a new run', async () => {
  const solvers = [];
  const runner = new FlowRunner({
    createSolver: async () => {
      const s = fakeSolver();
      solvers.push(s);
      return s;
    },
  });
  const result = await runner.run(request('cancel'), { onFrame: () => runner.cancel() });
  assert.equal(result.complete, false);
  assert.equal(result.frames.length, 1);
  assert.equal(result.frames[0].step, 32);
  assert.equal(runner.getCached('cancel'), undefined);
  assert.ok(solvers[0].destroyed);
  assert.equal(runner.running, false);
  const next = await runner.run(request('next'));
  assert.ok(next.complete);
});

test('failures retain partial results, never cache them, and release the GPU', async () => {
  const solver = fakeSolver({ failAt: 64 }),
    runner = new FlowRunner({ createSolver: async () => solver });
  let result;
  await assert.rejects(
    runner.run(request('bad'), { onStart: (r) => (result = r) }),
    /GPU test failure/,
  );
  assert.equal(result.failed, true);
  assert.equal(result.frames.length, 1);
  assert.equal(result.complete, false);
  assert.equal(runner.getCached('bad'), undefined);
  assert.ok(solver.destroyed);
  assert.equal(runner.running, false);
  const unavailable = new FlowRunner({
    createSolver: async () => {
      throw new Error('No GPU');
    },
  });
  await assert.rejects(unavailable.run(request('init')), /No GPU/);
  assert.equal(unavailable.running, false);
});

test('active conditions are isolated from edits; cancellation during initialization and duplicate starts are safe', async () => {
  let resolveSolver, captured;
  const solver = fakeSolver();
  const runner = new FlowRunner({
    createSolver: (cfg) => {
      captured = cfg;
      return new Promise((resolve) => (resolveSolver = resolve));
    },
  });
  const input = request('first');
  input.config.omega = [1, 2, 3];
  const pending = runner.run(input);
  input.condition.speed = 99;
  input.config.omega[0] = 99;
  await assert.rejects(runner.run(request('duplicate')), /すでに実行中/);
  runner.cancel();
  resolveSolver(solver);
  const result = await pending;
  assert.equal(result.condition.speed, 10);
  assert.deepEqual(captured.omega, [1, 2, 3]);
  assert.equal(result.frames.length, 0);
  assert.equal(result.complete, false);
  assert.ok(solver.destroyed);
});
