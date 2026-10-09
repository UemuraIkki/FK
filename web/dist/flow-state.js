import { DEFAULTS, validateParameters, dot, cross, unit } from './physics.js?v=4';
export function encodeFlowState(parameters, fraction = 0) {
  const p = validateParameters(parameters);
  if (!Number.isFinite(fraction) || fraction < 0 || fraction > 1)
    throw new Error('飛行時刻が不正です。');
  return '#' + new URLSearchParams({ kick: JSON.stringify(p), at: String(fraction) });
}
export function decodeFlowState(hash) {
  if (!hash || hash === '#') return { parameters: { ...DEFAULTS }, fraction: 0 };
  if (hash.length > 4000)
    throw new Error('設定リンクが長すぎます。軌道画面から開き直してください。');
  const q = new URLSearchParams(hash.slice(1));
  if ([...q.keys()].some((k) => !['kick', 'at'].includes(k)) || !q.has('kick'))
    throw new Error('設定リンクの形式が不正です。');
  const fraction = Number(q.get('at') ?? 0),
    input = JSON.parse(q.get('kick'));
  if (
    !input ||
    Array.isArray(input) ||
    typeof input !== 'object' ||
    !Number.isFinite(fraction) ||
    fraction < 0 ||
    fraction > 1
  )
    throw new Error('設定リンクの値が不正です。');
  return { parameters: validateParameters(input), fraction };
}
export function sampleFlight(flight, fraction) {
  const t = Math.max(0, Math.min(1, fraction)) * flight.duration;
  const i = flight.samples.findIndex((s) => s.t >= t);
  if (i <= 0) return { t, state: [...flight.samples[i < 0 ? flight.samples.length - 1 : 0].state] };
  const a = flight.samples[i - 1],
    b = flight.samples[i],
    f = (t - a.t) / (b.t - a.t);
  return { t, state: a.state.map((v, k) => v + (b.state[k] - v) * f) };
}
export function flowCondition(parameters, flight, fraction) {
  const p = validateParameters(parameters),
    { t, state } = sampleFlight(flight, fraction);
  // Local right-handed frame: +x points downstream (air relative to ball).
  const air = [-state[3] - p.headwind, p.crosswind - state[4], -state[5]];
  const speed = Math.hypot(...air);
  if (speed < 0.5)
    throw new Error('相対風速が0.5 m/s未満です。初速・風、または飛行時刻を変更してください。');
  const ex = unit(air),
    up = Math.abs(ex[2]) > 0.95 ? [0, 1, 0] : [0, 0, 1];
  const ey = unit(cross(up, ex)),
    ez = cross(ex, ey),
    axis = (p.axis * Math.PI) / 180;
  const omega = [0, -Math.sin(axis) * 2 * Math.PI * p.spin, Math.cos(axis) * 2 * Math.PI * p.spin];
  return {
    speed,
    diameter: p.diameter,
    density: p.density,
    nu: 1.5e-5,
    omega: [dot(omega, ex), dot(omega, ey), dot(omega, ez)],
    basis: [ex, ey, ez],
    flightTime: t,
    position: state.slice(0, 3),
    spin: p.spin,
    seed: p.seed,
  };
}
export const QUALITY = { coarse: 12, standard: 16, fine: 20 };
export function latticeConfig(condition, quality = 'standard', duration = 20) {
  const d = QUALITY[quality];
  if (!d || ![10, 20, 40].includes(duration)) throw new Error('計算品質または時間が不正です。');
  const c = condition;
  if (
    !Number.isFinite(c.speed) ||
    c.speed < 0.5 ||
    !Number.isFinite(c.diameter) ||
    c.diameter <= 0 ||
    !Number.isFinite(c.nu) ||
    c.nu <= 0 ||
    c.omega.length !== 3 ||
    c.omega.some((v) => !Number.isFinite(v))
  )
    throw new Error('CFDの条件が不正です。');
  // Preserve physical Reynolds number. Lattice speed is reduced for fast rotation,
  // keeping free-stream plus surface speed below 0.025 (Mach ~0.043).
  const surfaceSpeed = (Math.hypot(...c.omega) * c.diameter) / 2;
  const u = (0.025 * c.speed) / (c.speed + surfaceSpeed),
    dx = c.diameter / d,
    dt = (u * dx) / c.speed;
  const re = (c.speed * c.diameter) / c.nu,
    tau = 0.5 + (3 * c.nu * dt) / (dx * dx);
  return {
    nx: 10 * d,
    ny: 5 * d,
    nz: 5 * d,
    d,
    cx: 2.5 * d,
    cy: 2.5 * d,
    cz: 2.5 * d,
    u,
    dx,
    dt,
    re,
    tau,
    cs: 0.16,
    omega: c.omega.map((v) => v * dt),
    steps: Math.ceil((duration * d) / u),
    duration,
    seed: c.seed ?? 7,
    mode: 0,
  };
}
