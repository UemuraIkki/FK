import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULTS, simulate, dot, cross } from './dist/physics.js';
import {
  encodeFlowState,
  decodeFlowState,
  flowCondition,
  latticeConfig,
  sampleFlight,
} from './dist/flow-state.js';
import { C, W } from './dist/lbm-gpu.js';
const cal = JSON.parse(
  fs.readFileSync(new URL('./dist/calibration.json', import.meta.url), 'utf8'),
);
const close = (a, b, tol = 1e-10) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);
test('CFD links round-trip all controls and flight position; reject malformed input', () => {
  const p = { ...DEFAULTS, speed: 50, spin: -24, yaw: 90, elevation: 90, launchHeight: 1.25 };
  assert.deepEqual(decodeFlowState(encodeFlowState(p, 0.73)), { parameters: p, fraction: 0.73 });
  for (const hash of [
    '#kick=null',
    '#kick=[]',
    '#kick=%7B%22speed%22:500%7D',
    '#kick=%7B%7D&at=NaN',
    '#kick=%7B%7D&at=2',
    '#oops=1',
  ])
    assert.throws(() => decodeFlowState(hash));
});
test('Legacy links default to ground launch and zero-duration CFD samples stay finite', () => {
  const { launchHeight, ...legacy } = DEFAULTS;
  const restored = decodeFlowState('#' + new URLSearchParams({ kick: JSON.stringify(legacy) }));
  assert.equal(restored.parameters.launchHeight, 0);
  const p = { ...DEFAULTS, elevation: 0, knuckle: 0 },
    flight = simulate(p, cal);
  for (const fraction of [0, 0.5, 1]) {
    assert.deepEqual(sampleFlight(flight, fraction).state, flight.samples[0].state);
    const c = flowCondition(p, flight, fraction);
    assert.equal(c.flightTime, 0);
    assert.deepEqual(c.position, [0, 0, p.diameter / 2]);
    assert.ok(c.speed > 0);
    assert.ok(Number.isFinite(latticeConfig(c).dt));
  }
});
test('condition uses interpolated trajectory velocity and signed wind; frame is right handed', () => {
  const p = { ...DEFAULTS, spin: 7, axis: 30, headwind: 4, crosswind: -3 },
    flight = simulate(p, cal);
  const c = flowCondition(p, flight, 0),
    v = flight.samples[0].state.slice(3, 6),
    air = [-v[0] - 4, -3 - v[1], -v[2]];
  close(c.speed, Math.hypot(...air));
  for (let i = 0; i < 3; i++) close(c.basis[0][i], air[i] / c.speed);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++) close(dot(c.basis[i], c.basis[j]), i === j ? 1 : 0);
  cross(c.basis[0], c.basis[1]).forEach((n, i) => close(n, c.basis[2][i]));
  close(Math.hypot(...c.omega), 2 * Math.PI * 7);
});
test('lattice scaling preserves physical viscosity, Reynolds number, and wall angular speed', () => {
  for (const spin of [0, 0.3, 24, -24])
    for (const speed of [10, 50])
      for (const quality of ['coarse', 'standard', 'fine']) {
        const p = { ...DEFAULTS, speed, spin },
          c = flowCondition(p, simulate(p, cal), 0),
          g = latticeConfig(c, quality, 20);
        close((g.u * g.d) / ((g.tau - 0.5) / 3) / g.re, 1, 1e-8);
        close((g.dx / g.dt) * g.u, c.speed);
        c.omega.forEach((v, i) => close(g.omega[i] / g.dt, v));
        assert.ok((g.u + (Math.hypot(...g.omega) * g.d) / 2) * Math.sqrt(3) < 0.044);
        assert.ok(g.steps * g.dt >= (20 * c.diameter) / c.speed);
      }
});
test('D3Q19 quadrature has correct isotropic second and fourth moments', () => {
  close(
    W.reduce((a, b) => a + b),
    1,
  );
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++) {
      close(
        C.reduce((s, c, i) => s + W[i] * c[a] * c[b], 0),
        a === b ? 1 / 3 : 0,
      );
      for (let d = 0; d < 3; d++)
        for (let e = 0; e < 3; e++)
          close(
            C.reduce((s, c, i) => s + W[i] * c[a] * c[b] * c[d] * c[e], 0),
            ((a === b && d === e) + (a === d && b === e) + (a === e && b === d)) / 9,
          );
    }
});
