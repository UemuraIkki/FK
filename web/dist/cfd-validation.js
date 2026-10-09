import { GPULBM } from './lbm-gpu.js';
const output = document.getElementById('verification-result'),
  button = document.getElementById('verify');
button.addEventListener('click', async () => {
  button.disabled = wallButton.disabled = true;
  output.textContent = 'WebGPUを初期化しています…\n';
  let solver;
  const log = (s) => (output.textContent += s + '\n');
  try {
    const base = {
      nx: 32,
      ny: 32,
      nz: 32,
      d: 0,
      cx: 0,
      cy: 0,
      cz: 0,
      u: 0.02,
      tau: 0.56,
      cs: 0,
      omega: [0, 0, 0],
      seed: 0,
      mode: 2,
    };
    solver = await GPULBM.create(base);
    await solver.advance(100);
    let data = await solver.readCells();
    let err = 0,
      mass = 0;
    for (let i = 0; i < data.length; i += 12) {
      err = Math.max(err, Math.abs(data[i] - 0.02), Math.abs(data[i + 1]), Math.abs(data[i + 2]));
      mass += data[i + 3];
    }
    const massError = Math.abs(mass / 32 ** 3 - 1);
    if (!Number.isFinite(err) || !Number.isFinite(massError) || err > 2e-6 || massError > 2e-5)
      throw new Error(`一様流の保存に失敗: ${err}, ${massError}`);
    log(
      `PASS 一様流100ステップ: 最大速度誤差 ${err.toExponential(3)}, 平均密度誤差 ${massError.toExponential(3)}`,
    );
    solver.destroy();
    solver = null;
    for (const [mode, axis, component, label] of [
      [1, 0, 1, 'x方向 / uy'],
      [3, 1, 2, 'y方向 / uz'],
      [4, 2, 0, 'z方向 / ux'],
    ]) {
      solver = await GPULBM.create({ ...base, mode });
      await solver.advance(200);
      data = await solver.readCells();
      let amplitude = 0,
        mean = 0;
      for (let id = 0; id < 32 ** 3; id++) {
        const xyz = [id % 32, Math.floor(id / 32) % 32, Math.floor(id / 1024)];
        amplitude += data[id * 12 + component] * Math.sin((2 * Math.PI * xyz[axis]) / 32) * 2;
        mean += data[id * 12 + component];
      }
      amplitude /= 32 ** 3;
      mean /= 32 ** 3;
      const expected = 0.005 * Math.exp((-(0.56 - 0.5) / 3) * ((2 * Math.PI) / 32) ** 2 * 200),
        relative = Math.abs(amplitude / expected - 1);
      if (
        !Number.isFinite(relative) ||
        !Number.isFinite(mean) ||
        relative > 0.02 ||
        Math.abs(mean) > 1e-6
      )
        throw new Error(`せん断波の減衰に失敗: ${label}, 誤差 ${relative}`);
      log(
        `PASS せん断波 ${label}: 振幅 ${amplitude.toExponential(5)}, 解析解 ${expected.toExponential(5)}, 相対誤差 ${(relative * 100).toFixed(3)}%`,
      );
      solver.destroy();
      solver = null;
    }
    log('全ての数値検証に合格しました。');
  } catch (error) {
    log('FAIL ' + error.message);
  } finally {
    solver?.destroy();
    button.disabled = wallButton.disabled = false;
  }
});

const wallButton = document.getElementById('verify-wall');
wallButton.addEventListener('click', async () => {
  button.disabled = wallButton.disabled = true;
  output.textContent = '回転球の符号反転を検証中…\n';
  let solver;
  const results = [];
  try {
    for (const sign of [1, -1]) {
      const cfg = {
        nx: 100,
        ny: 50,
        nz: 50,
        d: 10,
        cx: 25,
        cy: 24.5,
        cz: 24.5,
        u: 0.025,
        tau: 0.5 + (3 * 0.025 * 10) / 200,
        cs: 0.16,
        omega: [0, 0, sign * 0.0025],
        seed: 7,
        mode: 0,
      };
      solver = await GPULBM.create(cfg);
      let sums = [0, 0, 0],
        count = 0;
      for (let step = 0; step < 4000; step += 32) {
        await solver.advance(32);
        if (step > 3000) {
          const f = await solver.snapshot();
          f.stats.force.forEach((v, k) => (sums[k] += v));
          count++;
        }
      }
      const force = sums.map((v) => v / count);
      results.push(force);
      output.textContent += `回転 ${sign > 0 ? '+' : '−'}: F = ${force.map((v) => v.toExponential(4)).join(', ')}\n`;
      solver.destroy();
      solver = null;
    }
    const [a, b] = results,
      sideError = Math.abs(a[1] + b[1]) / Math.max(Math.abs(a[1]), Math.abs(b[1]));
    if (!(a[0] > 0 && b[0] > 0 && a[1] < 0 && b[1] > 0 && sideError < 0.08))
      throw new Error('抗力・横力の符号または対称性の検証に失敗しました。');
    output.textContent += `PASS 両方の抗力が下流向き。回転反転で横力が反転。横力の対称性誤差 ${(sideError * 100).toFixed(2)}%\n`;
  } catch (error) {
    output.textContent += 'FAIL ' + error.message;
  } finally {
    solver?.destroy();
    button.disabled = wallButton.disabled = false;
  }
});
