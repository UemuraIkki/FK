/** SI units throughout. The LBM coefficients calibrate a reduced-order model;
 * the sphere drag crisis, Magnus law and low-frequency wandering are empirical.
 * Spin is fixed in the world frame. No moving-boundary CFD is performed here.
 */
export const DEFAULTS = Object.freeze({
  speed: 25,
  elevation: 22,
  yaw: 0,
  spin: 0,
  axis: 0,
  knuckle: 1,
  crosswind: 0,
  headwind: 0,
  mass: 0.43,
  diameter: 0.22,
  density: 1.225,
  criticalRe: 300000,
  distance: 30,
  seed: 7,
  wakeHalfSpin: 1.8,
});
export const CONTROLS = [
  { key: 'speed', label: '初速', min: 10, max: 50, step: 0.5, unit: 'm/s', digits: 1 },
  { key: 'elevation', label: '蹴り上げ角度', min: 0, max: 90, step: 1, unit: '°', digits: 0 },
  {
    key: 'spin',
    label: '回転数',
    min: -24,
    max: 24,
    step: 0.1,
    unit: '回転/s',
    digits: 1,
    hint: '0で完全な無回転。小さな回転でもブレが生じます。符号で回転が反転します。',
  },
  {
    key: 'axis',
    label: '回転軸の傾き',
    min: -90,
    max: 90,
    step: 5,
    unit: '°',
    digits: 0,
    hint: '正の回転数で、−90°は沈む、0°は横曲がり、+90°は浮く方向。',
  },
  { key: 'knuckle', label: '後流の揺らぎ', min: 0, max: 2, step: 0.05, unit: '倍', digits: 2 },
  {
    key: 'wakeHalfSpin',
    label: 'ブレの半減回転数',
    min: 0.2,
    max: 4,
    step: 0.1,
    unit: '回転/s',
    digits: 1,
    hint: '25 m/s・直径22 cmで、後流の横力振幅が無回転時の半分になる回転数。大きいほど回転してもブレが残ります。経験モデルの調整値です。',
  },
  {
    key: 'yaw',
    label: '左右の打ち出し角',
    min: -90,
    max: 90,
    step: 0.5,
    unit: '°',
    digits: 1,
    advanced: true,
  },
  {
    key: 'crosswind',
    label: '横風',
    min: -10,
    max: 10,
    step: 0.5,
    unit: 'm/s',
    digits: 1,
    advanced: true,
    hint: '正の値は、蹴る人から見て右へ吹く風。',
  },
  {
    key: 'headwind',
    label: '向かい風',
    min: -10,
    max: 10,
    step: 0.5,
    unit: 'm/s',
    digits: 1,
    advanced: true,
    hint: '負の値で追い風になります。',
  },
  {
    key: 'mass',
    label: 'ボールの質量',
    min: 0.35,
    max: 0.5,
    step: 0.01,
    unit: 'kg',
    digits: 2,
    advanced: true,
  },
  {
    key: 'diameter',
    label: 'ボールの直径',
    min: 0.18,
    max: 0.26,
    step: 0.01,
    unit: 'm',
    digits: 2,
    advanced: true,
  },
  {
    key: 'density',
    label: '空気密度',
    min: 0.9,
    max: 1.3,
    step: 0.025,
    unit: 'kg/m³',
    digits: 3,
    advanced: true,
  },
  {
    key: 'criticalRe',
    label: '抗力危機の中心 Re',
    min: 180000,
    max: 400000,
    step: 10000,
    unit: '',
    digits: 0,
    advanced: true,
  },
  {
    key: 'distance',
    label: 'ゴールまでの距離',
    min: 15,
    max: 40,
    step: 1,
    unit: 'm',
    digits: 0,
    advanced: true,
  },
  {
    key: 'seed',
    label: '後流パターン',
    min: 1,
    max: 30,
    step: 1,
    unit: '',
    digits: 0,
    advanced: true,
    hint: '同じ番号なら、同じ揺らぎで比較できます。',
  },
];
export const PRESETS = {
  lowspin: { spin: 0.3, axis: 0, speed: 25, elevation: 22, knuckle: 1, wakeHalfSpin: 1.8 },
  knuckle: { spin: 0, axis: 0, speed: 25, elevation: 22, knuckle: 1 },
  curve: { spin: 5, axis: 0, speed: 27, elevation: 20, knuckle: 1 },
  drive: { spin: 7, axis: -90, speed: 30, elevation: 24, knuckle: 1 },
  backspin: { spin: 5, axis: 90, speed: 25, elevation: 15, knuckle: 1 },
};
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a) => Math.hypot(...a);
export const unit = (a) => {
  const n = norm(a);
  return n > 1e-12 ? a.map((v) => v / n) : [0, 0, 0];
};
const radians = (a) => (a * Math.PI) / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function validateParameters(input, base = DEFAULTS) {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('設定はオブジェクトで指定してください。');
  const result = { ...base };
  for (const [key, value] of Object.entries(input)) {
    const spec = CONTROLS.find((c) => c.key === key);
    if (
      !spec ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value < spec.min ||
      value > spec.max
    )
      throw new Error(`設定「${key}」が範囲外です。`);
    if (key === 'seed' && !Number.isInteger(value))
      throw new Error('後流パターンは整数で指定してください。');
    result[key] = value;
  }
  return result;
}

function randomGenerator(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function makeNoise(seed, calibration) {
  if (seed === 7) return calibration.noise;
  const random = randomGenerator(seed + 1000);
  const gaussian = () =>
    Math.sqrt(-2 * Math.log(Math.max(random(), 1e-12))) * Math.cos(2 * Math.PI * random());
  const dt = 0.005,
    decay = [0.24, 0.2, 0.36].map((c) => Math.exp(-dt / c));
  const values = [Array.from({ length: 3 }, gaussian)];
  for (let k = 1; k <= 1600; k++)
    values.push(decay.map((d, j) => d * values[k - 1][j] + Math.sqrt(1 - d * d) * gaussian()));
  return { dt, values };
}
function noiseAt(t, noise) {
  const q = clamp(t / noise.dt, 0, noise.values.length - 1),
    i = Math.floor(q),
    j = Math.min(i + 1, noise.values.length - 1),
    f = q - i;
  return noise.values[i].map((v, k) => v * (1 - f) + noise.values[j][k] * f);
}
export function coefficients(t, s, p, calibration, noise) {
  // Coordinates: x downrange, y right, z up. Positive headwind is wind in -x.
  const relative = [s[3] + p.headwind, s[4] - p.crosswind, s[5]];
  const speed = norm(relative),
    vhat = unit(relative),
    re = (speed * p.diameter) / 1.5e-5;
  const z = noiseAt(t, noise),
    h = clamp(s[7], 0, 1);
  const critical = p.criticalRe * (1 + 0.14 * p.knuckle * Math.tanh(z[0]));
  const target = 1 / (1 + Math.exp(clamp(-(re - critical) / 30000, -60, 60)));
  const wake = calibration.wake,
    coef = wake.coefficients;
  let drag = coef[0][0],
    lift = coef[0][1];
  const phase = 2 * Math.PI * wake.strouhal * s[6];
  for (let j = 1; j <= 3; j++) {
    const a = Math.sin(j * phase),
      b = Math.cos(j * phase);
    drag += coef[2 * j - 1][0] * a + coef[2 * j][0] * b;
    lift += coef[2 * j - 1][1] * a + coef[2 * j][1] * b;
  }
  const cd = (0.48 * (1 - h) + 0.2 * h) * Math.exp(0.35 * clamp(drag / coef[0][0] - 1, -1, 1));
  const axis = radians(p.axis),
    omega = [0, -Math.sin(axis) * 2 * Math.PI * p.spin, Math.cos(axis) * 2 * Math.PI * p.spin];
  const magnusVector = cross(omega, relative),
    magnusNorm = norm(magnusVector);
  const spinRatio = ((p.diameter / 2) * magnusNorm) / Math.max(speed * speed, 1e-12);
  // Smooth bounded empirical Magnus coefficient. Its direction changes sign
  // with omega; axial spin creates no Magnus force. Cm is a magnitude.
  const cm = (0.6 * spinRatio) / (0.3 + spinRatio);
  // Empirical smooth spin/wake coupling, not a measured universal threshold.
  // Total spin controls this rough-ball wake closure; only transverse spin
  // controls Magnus lift. Use relative airspeed, including wind and deceleration.
  const wakeSpinRatio = (Math.PI * p.diameter * Math.abs(p.spin)) / Math.max(speed, 1e-6);
  const halfSpinRatio = (Math.PI * 0.22 * p.wakeHalfSpin) / 25;
  const wakeRetention = Math.exp(-Math.LN2 * (wakeSpinRatio / halfSpinRatio) ** 2);
  const cl =
    p.knuckle *
    wakeRetention *
    0.55 *
    (0.65 + 0.8 * 4 * h * (1 - h)) *
    (0.15 * coef[0][1] + 0.35 * (lift - coef[0][1]) + 1.4 * wake.lift_rms * Math.tanh(z[1]));
  let ref = [0, 1, 0];
  if (Math.abs(dot(ref, vhat)) > 0.95) ref = [1, 0, 0];
  const projection = dot(ref, vhat),
    e1 = unit(ref.map((v, i) => v - projection * vhat[i]));
  const e2 = cross(vhat, e1),
    angle = 0.65 * Math.tanh(z[2]);
  const lateral = e1.map((v, i) => Math.cos(angle) * v + Math.sin(angle) * e2[i]);
  return {
    cd,
    cl,
    cm,
    re,
    speed,
    relative,
    lateral,
    magnus: unit(magnusVector),
    target,
    spinRatio,
    wakeSpinRatio,
    wakeRetention,
  };
}
export function derivative(t, s, p, calibration, noise, includeSide = true) {
  const c = coefficients(t, s, p, calibration, noise),
    factor = (0.5 * p.density * Math.PI * p.diameter ** 2) / 4 / p.mass;
  const acceleration = c.relative.map(
    (v, i) =>
      -factor * c.cd * c.speed * v +
      (i === 2 ? -9.81 : 0) +
      (includeSide ? factor * c.speed ** 2 * (c.cl * c.lateral[i] + c.cm * c.magnus[i]) : 0),
  );
  return [s[3], s[4], s[5], ...acceleration, c.speed / p.diameter, (c.target - s[7]) / 0.075];
}
function rk4(t, s, dt, rhs) {
  const add = (k, h) => s.map((v, i) => v + h * k[i]);
  const a = rhs(t, s),
    b = rhs(t + dt / 2, add(a, dt / 2)),
    c = rhs(t + dt / 2, add(b, dt / 2)),
    d = rhs(t + dt, add(c, dt));
  return s.map((v, i) => v + (dt * (a[i] + 2 * b[i] + 2 * c[i] + d[i])) / 6);
}
export function simulate(input, calibration, options = {}) {
  const p = validateParameters(input),
    noise = makeNoise(p.seed, calibration),
    dt = options.dt ?? 1 / 600;
  const elevation = radians(p.elevation),
    yaw = radians(p.yaw);
  let state = [
    0,
    0,
    0.35,
    p.speed * Math.cos(elevation) * Math.cos(yaw),
    p.speed * Math.cos(elevation) * Math.sin(yaw),
    p.speed * Math.sin(elevation),
    0,
    0.5,
  ];
  state[7] = coefficients(0, state, p, calibration, noise).target;
  const rhs = (t, s) => derivative(t, s, p, calibration, noise, options.includeSide !== false);
  const record = (t, s) => ({ t, state: s.slice(), ...coefficients(t, s, p, calibration, noise) });
  const samples = [record(0, state)];
  let t = 0,
    ending = 'time',
    apex = state[2];
  for (let step = 1; t < 8 - 1e-10; step++) {
    const h = Math.min(dt, 8 - t),
      next = rk4(t, state, h, rhs);
    if (!next.every(Number.isFinite))
      throw new Error('計算が不安定になりました。設定をリセットしてください。');
    let fraction = 1,
      hit = false;
    if (next[0] >= p.distance && next[0] > state[0]) {
      fraction = (p.distance - state[0]) / (next[0] - state[0]);
      ending = 'goal';
      hit = true;
    }
    if (next[2] <= p.diameter / 2) {
      const groundFraction = (p.diameter / 2 - state[2]) / (next[2] - state[2]);
      if (groundFraction <= fraction) {
        fraction = groundFraction;
        ending = 'ground';
        hit = true;
      }
    }
    if (hit) {
      state = state.map((v, i) => v + fraction * (next[i] - v));
      t += h * fraction;
      apex = Math.max(apex, state[2]);
      samples.push(record(t, state));
      break;
    }
    state = next;
    t += h;
    apex = Math.max(apex, state[2]);
    if (step % 4 === 0 || t >= 8 - 1e-10) samples.push(record(t, state));
  }
  return { parameters: p, samples, ending, apex, duration: t, final: state };
}
