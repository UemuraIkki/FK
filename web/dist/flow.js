import { createFlowRenderer, drawFlightPreview } from './flow-view.js?v=3';
import { sliceCSV } from './flow-field.js';
import { simulate } from './physics.js?v=5';
import {
  decodeFlowState,
  encodeFlowState,
  flowCondition,
  latticeConfig,
} from './flow-state.js?v=3';
import { FlowRunner } from './flow-runner.js';
const $ = (id) => document.getElementById(id),
  runner = new FlowRunner();
let parameters,
  fraction = 0,
  flight,
  condition,
  config,
  active = null,
  busy = false,
  plane = 'xy',
  frameIndex = 0,
  playing = false,
  lastFrame = 0;
const plot = $('flow-canvas'),
  renderer = createFlowRenderer(plot);
function status(message, error = false) {
  $('cfd-status').textContent = message;
  $('cfd-status').classList.toggle('error', error);
}
function selectionKey() {
  return JSON.stringify({
    condition,
    quality: $('quality').value,
    duration: Number($('duration').value),
  });
}
function isStale() {
  return active && active.key !== selectionKey();
}
function updateSelection() {
  if (!flight) return;
  $('flight-time').disabled = flight.duration === 0;
  if (flight.duration === 0) $('flight-time').value = 0;
  fraction = Number($('flight-time').value);
  $('flight-time-value').textContent = `${(fraction * flight.duration).toFixed(3)} s`;
  const hash = encodeFlowState(parameters, fraction);
  history.replaceState(null, '', hash);
  $('back-to-flight').href = $('flight-link').href = './' + hash;
  drawTrajectory();
  try {
    condition = flowCondition(parameters, flight, fraction);
    config = latticeConfig(condition, $('quality').value, Number($('duration').value));
    $('condition-speed').textContent = `${condition.speed.toFixed(2)} m/s`;
    $('condition-spin').textContent = `${parameters.spin.toFixed(2)} 回転/s`;
    $('condition-diameter').textContent = `${(100 * parameters.diameter).toFixed(1)} cm`;
    $('condition-re').textContent = Math.round(config.re).toLocaleString('ja-JP');
    $('run-estimate').textContent =
      `${config.nx} × ${config.ny} × ${config.nz}格子 · ${config.steps.toLocaleString()}ステップ\n後流 ${(config.steps * config.dt).toFixed(3)} s分を計算。必要なGPUメモリは約${Math.ceil((config.nx * config.ny * config.nz * 200) / 1e6)} MB。`;
    $('run-cfd').disabled = busy || !navigator.gpu;
    if (isStale()) {
      $('result-state').textContent = '条件変更・再計算が必要';
      $('result-state').classList.add('stale');
      if (!busy) status('表示中の流れは前の条件です。「CFDを計算」で更新してください。');
    } else if (active) {
      $('result-state').classList.remove('stale');
      $('result-state').textContent = busy
        ? 'CFD計算中'
        : active.complete
          ? 'CFD計算済み'
          : '途中までの結果';
    }
  } catch (error) {
    condition = null;
    config = null;
    $('run-cfd').disabled = true;
    status(error.message, true);
    $('condition-speed').textContent = '計算対象外';
    if (active) {
      $('result-state').textContent = '条件変更・再計算が必要';
      $('result-state').classList.add('stale');
    }
  }
}
function drawTrajectory() {
  drawFlightPreview($('local-trajectory'), flight, fraction);
}
function currentFrame() {
  return active?.frames[frameIndex];
}
function draw() {
  const legend = renderer.draw({
    result: active,
    frame: currentFrame(),
    plane,
    type: $('field-type').value,
    showVectors: $('show-vectors').checked,
  });
  if (!legend) return;
  $('color-min').textContent = legend.min;
  $('color-max').textContent = legend.max;
  $('colorbar').style.background = legend.gradient;
  $('field-unit').textContent = legend.unit;
  $('plane-caption').textContent = legend.caption;
}
function showFrame(index) {
  if (!active?.frames.length) return;
  frameIndex = Math.max(0, Math.min(active.frames.length - 1, index));
  const f = currentFrame(),
    g = active.config;
  $('flow-empty').hidden = true;
  $('result-flight-time').innerHTML = `${active.condition.flightTime.toFixed(3)}<small>s</small>`;
  $('result-flow-time').innerHTML = `${((f.step * g.u) / g.d).toFixed(1)}<small>D/U</small>`;
  $('result-steps').textContent = f.step.toLocaleString();
  $('frame-time').textContent = `CFD ${(f.step * g.dt).toFixed(3)} s`;
  $('flow-timeline').max = active.frames.length - 1;
  $('flow-timeline').value = frameIndex;
  $('flow-timeline').disabled = busy;
  $('flow-play').disabled = busy || active.frames.length < 2;
  $('export-slice').disabled = busy;
  $('diag-mach').textContent = f.stats.maxMa.toFixed(4);
  $('diag-density').textContent = `${((f.stats.meanRho - 1) * 100).toFixed(3)}%`;
  $('diag-limiter').textContent = `${((f.stats.limited / f.stats.count) * 100).toFixed(4)}%`;
  $('result-note').textContent =
    `計算条件：相対風速 ${active.condition.speed.toFixed(2)} m/s、回転 ${active.condition.spin.toFixed(2)} 回転/s、Re ${Math.round(g.re).toLocaleString()}。${f.stats.maxMa > 0.1 ? 'Maが0.1を超えています。圧縮性誤差に注意してください。' : ''}表示は三次元CFDの断面です。`;
  draw();
}
$('run-cfd').addEventListener('click', async () => {
  if (!config || busy) return;
  const key = selectionKey();
  playing = false;
  $('flow-play').textContent = '▶ 再生';
  if (runner.getCached(key)) {
    active = runner.getCached(key);
    $('cfd-progress').value = 1;
    updateSelection();
    showFrame(active.frames.length - 1);
    status('同一条件で計算済みのCFD結果を再表示しました。');
    return;
  }
  busy = true;
  $('run-cfd').disabled = true;
  $('cancel-cfd').hidden = false;
  $('cfd-progress').value = 0;
  $('result-state').classList.remove('stale');
  $('result-state').textContent = 'CFD準備中';
  $('flow-empty').hidden = false;
  $('flow-empty').firstElementChild.textContent = 'GPUで計算を準備しています';
  $('flow-play').disabled = $('flow-timeline').disabled = $('export-slice').disabled = true;
  try {
    status('GPUを初期化しています。');
    const result = await runner.run(
      { key, condition, config },
      {
        onStart: (result) => {
          active = result;
        },
        onFrame: () => showFrame(active.frames.length - 1),
        onProgress: ({ step, steps, elapsed, progress }) => {
          $('cfd-progress').value = progress;
          status(
            `CFD計算中 ${Math.round(progress * 100)}% · ${step.toLocaleString()} / ${steps.toLocaleString()}\n経過 ${formatTime(elapsed)} · 残り目安 ${formatTime((elapsed * (1 - progress)) / Math.max(progress, 0.001))}${isStale() ? '\n条件が変更されています。現在の計算には反映されません。' : ''}`,
          );
          $('result-state').textContent = isStale() ? '条件変更・再計算が必要' : 'CFD計算中';
        },
      },
    );
    if (result.complete) {
      status(
        `CFD計算が完了しました（${formatTime(result.elapsed)}）。計算した後流を再生できます。`,
      );
    } else status('計算を中止しました。取得できた途中までの結果を表示しています。');
  } catch (error) {
    status(error.message || String(error), true);
  } finally {
    busy = false;
    $('cancel-cfd').hidden = true;
    updateSelection();
    if (active.frames.length) showFrame(active.frames.length - 1);
    else {
      $('flow-empty').firstElementChild.textContent = '計算結果を取得できませんでした';
      $('flow-empty').hidden = false;
    }
    if (active.failed && !isStale()) $('result-state').textContent = '計算停止';
  }
});
function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '計測中';
  return seconds < 60
    ? `${Math.ceil(seconds)}秒`
    : `${Math.floor(seconds / 60)}分${Math.round(seconds % 60)}秒`;
}
$('cancel-cfd').addEventListener('click', () => {
  runner.cancel();
  status('実行中の計算区間が終わり次第、中止します。');
});
for (const id of ['flight-time', 'quality', 'duration'])
  $(id).addEventListener('input', updateSelection);
for (const button of document.querySelectorAll('[data-plane]'))
  button.addEventListener('click', () => {
    plane = button.dataset.plane;
    document.querySelectorAll('[data-plane]').forEach((b) => {
      b.classList.toggle('selected', b === button);
      b.setAttribute('aria-pressed', String(b === button));
    });
    draw();
  });
for (const id of ['field-type', 'show-vectors']) $(id).addEventListener('change', draw);
$('flow-play').addEventListener('click', () => {
  playing = !playing;
  if (frameIndex >= active.frames.length - 1) showFrame(0);
  $('flow-play').textContent = playing ? 'Ⅱ 一時停止' : '▶ 再生';
});
$('flow-timeline').addEventListener('input', () => {
  playing = false;
  $('flow-play').textContent = '▶ 再生';
  showFrame(Number($('flow-timeline').value));
});
function animate(now) {
  if (playing && active && !busy && now - lastFrame > 120) {
    showFrame((frameIndex + 1) % active.frames.length);
    lastFrame = now;
  }
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);
$('export-slice').addEventListener('click', () => {
  const f = currentFrame();
  if (!f) return;
  const csv = sliceCSV(active, f, plane);
  const a = document.createElement('a'),
    url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  a.href = url;
  a.download = `cfd-${plane}-${f.step}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
new ResizeObserver(() => {
  draw();
  if (flight) drawTrajectory();
}).observe(plot);
try {
  ({ parameters, fraction } = decodeFlowState(location.hash));
  $('flight-time').value = fraction;
  const response = await fetch('./calibration.json');
  if (!response.ok) throw new Error('軌道の計算データを読み込めませんでした。');
  flight = simulate(parameters, await response.json());
  $('flight-end').textContent =
    flight.duration === 0 ? '空中飛行なし・キック時の条件' : `${flight.duration.toFixed(2)} s`;
  $('gpu-status').textContent = navigator.gpu
    ? 'このブラウザはWebGPUに対応しています。計算はこの端末で行います。'
    : 'WebGPU非対応です。対応するブラウザで開いてください。';
  updateSelection();
  status(
    navigator.gpu ? '条件を選んで計算を開始できます。' : 'WebGPU対応ブラウザが必要です。',
    !navigator.gpu,
  );
} catch (error) {
  status(error.message, true);
  $('run-cfd').disabled = true;
}
