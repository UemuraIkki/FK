import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  DEFAULTS,
  CONTROLS,
  PRESETS,
  simulate,
  coefficients,
  makeNoise,
  dot,
  validateParameters,
} from './dist/physics.js';
const calibration = JSON.parse(
  fs.readFileSync(new URL('./dist/calibration.json', import.meta.url)),
);
let checks = 0;
function check(name, test) {
  test();
  checks++;
  console.log(`PASS ${name}`);
}
check('Python RK45 baseline agrees to 0.1 mm', () => {
  // The recorded Python reference starts at centre height 0.35 m.
  const result = simulate({ ...DEFAULTS, launchHeight: 0.35 - DEFAULTS.diameter / 2 }, calibration);
  assert.equal(result.ending, 'goal');
  assert.ok(Math.abs(result.final[1] - -0.40176398595737856) < 1e-4);
  assert.ok(Math.abs(result.final[2] - 0.8430500339830915) < 1e-4);
  assert.ok(Math.abs(result.duration - 1.7121619733855118) < 1e-5);
});
check('Ground launch keeps the ball bottom on the surface for every diameter', () => {
  for (const diameter of [0.18, 0.22, 0.26]) {
    const result = simulate({ ...DEFAULTS, diameter }, calibration);
    assert.deepEqual(result.samples[0].state.slice(0, 3), [0, 0, diameter / 2]);
    assert.ok(result.duration > 0);
    assert.ok(result.samples.every((s) => s.state[2] >= diameter / 2));
  }
  const ground = simulate(DEFAULTS, calibration),
    raised = simulate({ ...DEFAULTS, launchHeight: 0.24 }, calibration);
  assert.equal(ground.ending, 'goal');
  assert.ok(Math.abs(raised.final[2] - ground.final[2] - 0.24) < 1e-10);
  assert.ok(Math.abs(raised.duration - ground.duration) < 1e-10);
});
check('Horizontal ground contact has one finite sample and raised horizontal kicks fly', () => {
  const p = { ...DEFAULTS, elevation: 0, knuckle: 0, spin: 0 };
  const grounded = simulate(p, calibration);
  assert.equal(grounded.ending, 'ground');
  assert.equal(grounded.duration, 0);
  assert.equal(grounded.samples.length, 1);
  assert.deepEqual(grounded.final.slice(0, 3), [0, 0, p.diameter / 2]);
  const raised = simulate({ ...p, launchHeight: 0.5 }, calibration);
  assert.equal(raised.ending, 'ground');
  assert.ok(raised.duration > 0.2);
  assert.equal(raised.final[2], p.diameter / 2);
});
check('Hops shorter than one RK4 step retain positive flight time and converge', () => {
  for (const elevation of [0.001, 0.01, 0.02]) {
    const p = { ...DEFAULTS, elevation, knuckle: 0, spin: 0 };
    const coarse = simulate(p, calibration),
      fine = simulate(p, calibration, { dt: 1 / 60000 });
    assert.equal(coarse.ending, 'ground');
    assert.ok(coarse.duration > 0);
    assert.ok(coarse.final[0] > 0);
    assert.ok(coarse.apex > p.diameter / 2);
    assert.equal(coarse.final[2], p.diameter / 2);
    assert.ok(Math.abs(coarse.duration - fine.duration) < 1e-8);
    assert.ok(Math.abs(coarse.final[0] - fine.final[0]) < 1e-6);
    assert.ok(coarse.samples.slice(1).every((s, i) => s.t > coarse.samples[i].t));
  }
});
check('Upward Magnus lift can launch a horizontal kick from ground contact', () => {
  const result = simulate(
    { ...DEFAULTS, elevation: 0, knuckle: 0, spin: 24, axis: 90 },
    calibration,
  );
  assert.ok(result.duration > 0.1);
  assert.ok(result.apex > DEFAULTS.diameter / 2);
  assert.ok(result.samples[1].state[5] > 0);
});
check('Launch height and solver step reject invalid values', () => {
  for (const launchHeight of [-0.01, 2.01, NaN, Infinity])
    assert.throws(() => simulate({ ...DEFAULTS, launchHeight }, calibration));
  for (const dt of [0, -1, NaN, Infinity])
    assert.throws(() => simulate(DEFAULTS, calibration, { dt }));
});
check('Spin reversal mirrors the trajectory with no wake wandering', () => {
  const p = { ...DEFAULTS, knuckle: 0, spin: 5 };
  const a = simulate(p, calibration),
    b = simulate({ ...p, spin: -5 }, calibration);
  assert.ok(a.final[1] > 1);
  assert.ok(Math.abs(a.final[1] + b.final[1]) < 1e-10);
  assert.ok(Math.abs(a.final[2] - b.final[2]) < 1e-10);
});
check('Backspin raises the trajectory and topspin lowers it', () => {
  const p = { ...DEFAULTS, spin: 5, knuckle: 0 };
  const base = simulate({ ...p, spin: 0 }, calibration),
    back = simulate({ ...p, axis: 90 }, calibration),
    top = simulate({ ...p, axis: -90 }, calibration);
  assert.ok(back.apex > base.apex);
  assert.ok(top.apex < base.apex);
});
check('Lift and Magnus forces are perpendicular to air-relative velocity', () => {
  const p = { ...DEFAULTS, spin: 4, axis: 30, crosswind: 5, headwind: 2 },
    s = [3, 1, 2, 21, 0.5, 3, 8, 0.5];
  const c = coefficients(0.2, s, p, calibration, makeNoise(7, calibration));
  assert.ok(Math.abs(dot(c.relative, c.magnus)) < 1e-12);
  assert.ok(Math.abs(dot(c.relative, c.lateral)) < 1e-12);
});
check('RK4 step refinement converges', () => {
  const p = { ...DEFAULTS, spin: 7, axis: -45, crosswind: 3 };
  const a = simulate(p, calibration, { dt: 1 / 600 }),
    b = simulate(p, calibration, { dt: 1 / 1200 });
  for (let i = 0; i < 3; i++) assert.ok(Math.abs(a.final[i] - b.final[i]) < 2e-4);
});
check('Every slider endpoint produces a finite bounded flight', () => {
  for (const spec of CONTROLS)
    for (const v of [spec.min, spec.max]) {
      const r = simulate({ ...DEFAULTS, [spec.key]: v }, calibration);
      assert.ok(r.final.every(Number.isFinite), `${spec.key}=${v}`);
      assert.ok(r.duration <= 8.00001);
      if (r.ending === 'ground') assert.ok(Math.abs(r.final[2] - r.parameters.diameter / 2) < 1e-9);
    }
});
check('Invalid settings fail before changing the supplied base', () => {
  const base = { ...DEFAULTS };
  assert.throws(() => validateParameters({ spin: 99 }, base));
  assert.throws(() => validateParameters({ seed: 1.5 }, base));
  assert.throws(() => validateParameters({ unexpected: 1 }, base));
  assert.deepEqual(base, DEFAULTS);
});
check('Wake binary and calibration dimensions agree', () => {
  const meta = calibration.wakeFrames,
    bytes = fs.readFileSync(new URL('./dist/wake.bin', import.meta.url));
  assert.equal(bytes.length, meta.width * meta.height * meta.frames);
});
check('Low-spin wake varies continuously while Magnus grows from zero', () => {
  const s = [0, 0, 0.35, 25, 0, 0, 8, 0.5],
    noise = makeNoise(7, calibration);
  const at = (spin) => coefficients(0.2, s, { ...DEFAULTS, spin }, calibration, noise);
  const samples = [0, 0.3, 1.8, 5].map(at);
  assert.ok(Math.abs(samples[0].cl) > 1e-8);
  assert.equal(samples[0].cm, 0);
  assert.equal(samples[0].wakeRetention, 1);
  for (let i = 1; i < samples.length; i++) {
    assert.ok(Math.abs(samples[i].cl) < Math.abs(samples[i - 1].cl));
    assert.ok(samples[i].cm > samples[i - 1].cm);
  }
  assert.ok(samples[1].wakeRetention > 0.98);
  assert.ok(Math.abs(at(1e-8).cl - samples[0].cl) < 1e-12);
  assert.equal(at(-0.3).wakeRetention, at(0.3).wakeRetention);
});
check('Half-spin setting has SI scaling with wind and diameter', () => {
  const s = [0, 0, 0.35, 25, 0, 0, 8, 0.5],
    noise = makeNoise(7, calibration);
  for (const half of [0.2, 1.8, 4]) {
    const p = { ...DEFAULTS, spin: half, wakeHalfSpin: half };
    const c = coefficients(0.2, s, p, calibration, noise);
    assert.ok(Math.abs(c.wakeRetention - 0.5) < 1e-12);
    const zero = coefficients(0.2, s, { ...p, spin: 0 }, calibration, noise);
    assert.ok(Math.abs(c.cl / zero.cl - 0.5) < 1e-12);
    const windy = coefficients(
      0.2,
      s,
      { ...p, headwind: 10, spin: (half * 35) / 25 },
      calibration,
      noise,
    );
    const larger = coefficients(
      0.2,
      s,
      { ...p, diameter: 0.26, spin: (half * 0.22) / 0.26 },
      calibration,
      noise,
    );
    assert.ok(Math.abs(windy.wakeRetention - 0.5) < 1e-12);
    assert.ok(Math.abs(larger.wakeRetention - 0.5) < 1e-12);
  }
  const narrow = coefficients(
    0.2,
    s,
    { ...DEFAULTS, spin: 1, wakeHalfSpin: 0.2 },
    calibration,
    noise,
  );
  const wide = coefficients(0.2, s, { ...DEFAULTS, spin: 1, wakeHalfSpin: 4 }, calibration, noise);
  assert.ok(wide.wakeRetention > narrow.wakeRetention);
  assert.equal(wide.cm, narrow.cm);
  assert.equal(wide.cd, narrow.cd);
});
check('Axial spin suppresses the empirical wake without creating Magnus lift', () => {
  const s = [0, 0, 0.35, 0, 0, 25, 8, 0.5],
    p = { ...DEFAULTS, spin: 1.8, axis: 0 },
    noise = makeNoise(7, calibration);
  const c = coefficients(0.2, s, p, calibration, noise);
  assert.equal(c.cm, 0);
  assert.ok(Math.abs(c.wakeRetention - 0.5) < 1e-12);
  const stationary = coefficients(0.2, [0, 0, 0.35, 0, 0, 0, 8, 0.5], p, calibration, noise);
  assert.ok(
    [stationary.cd, stationary.cl, stationary.cm, stationary.wakeRetention].every(Number.isFinite),
  );
});
check('Low-spin preset retains a variable wake and integrates to a finite flight', () => {
  const r = simulate({ ...DEFAULTS, ...PRESETS.lowspin }, calibration);
  assert.ok(r.parameters.spin > 0);
  assert.ok(r.samples[0].wakeRetention > 0.98);
  assert.ok(r.samples.some((s) => s.cl > 0) && r.samples.some((s) => s.cl < 0));
  assert.ok(r.final.every(Number.isFinite));
  assert.ok(r.duration > 0);
  const noWake = simulate({ ...r.parameters, knuckle: 0 }, calibration);
  assert.ok(noWake.samples.every((s) => s.cl === 0));
});
console.log(`${checks} physics checks passed.`);
