import { createFlightRenderer } from './flight-view.js?v=3';
import { DEFAULTS, CONTROLS, PRESETS, validateParameters, simulate } from './physics.js?v=5';
import { encodeFlowState, decodeFlowState } from './flow-state.js?v=3';
const $ = (id) => document.getElementById(id);
let parameters = { ...DEFAULTS },
  calibration,
  flight,
  reference,
  view = 'perspective',
  analysis = 'forces';
let fraction = 1,
  playing = false,
  lastTime = 0,
  scheduled = 0,
  wakeData;
let camera = { yaw: -2.18, pitch: 0.66, zoom: 1 };
// Orbit above and below the pitch; stop short of the poles to keep 'up' stable.
const clampCameraPitch = (pitch) => Math.max(-1.48, Math.min(1.48, pitch));
const canvas = $('flight-canvas');
const renderer = createFlightRenderer(canvas, $('forces-canvas'), $('wake-canvas'));
let restoredFraction = null;
try {
  if (location.hash) {
    const restored = decodeFlowState(location.hash);
    parameters = restored.parameters;
    restoredFraction = restored.fraction;
  }
} catch (error) {
  console.warn(error.message);
}
function updateFlowLink() {
  $('open-cfd').href = './flow.html' + encodeFlowState(parameters, fraction);
}

for (const spec of CONTROLS) {
  const group = document.createElement('div');
  group.className = 'control-group';
  group.innerHTML = `<div class="control-top"><label for="number-${spec.key}">${spec.label}</label><div class="control-value"><input type="number" id="number-${spec.key}" min="${spec.min}" max="${spec.max}" step="${spec.key === 'seed' ? 1 : 'any'}" required aria-describedby="unit-${spec.key} error-${spec.key}${spec.hint ? ` hint-${spec.key}` : ''}"><span id="unit-${spec.key}" class="control-unit">${spec.unit}</span></div></div><input type="range" id="control-${spec.key}" aria-label="${spec.label}（スライダー）" min="${spec.min}" max="${spec.max}" step="any" value="${parameters[spec.key]}"${spec.hint ? ` aria-describedby="hint-${spec.key}"` : ''}><div class="control-scale"><span>${spec.min.toLocaleString('ja-JP')}</span><span>${spec.max.toLocaleString('ja-JP')}</span></div><p id="error-${spec.key}" class="control-error" aria-live="polite" hidden></p>${spec.hint ? `<p class="control-hint" id="hint-${spec.key}">${spec.hint}</p>` : ''}`;
  $(spec.advanced ? 'advanced-controls' : 'main-controls').append(group);
  const slider = $(`control-${spec.key}`),
    number = $(`number-${spec.key}`);
  slider.addEventListener('input', () => {
    // Preserve the slider's original increments, while displaying typed fractions exactly.
    const value = spec.min + Math.round((Number(slider.value) - spec.min) / spec.step) * spec.step;
    changeParameter(spec, Math.max(spec.min, Math.min(spec.max, Number(value.toFixed(10)))));
  });
  slider.addEventListener('keydown', (event) => {
    const direction = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1 }[event.key];
    if (!direction) return;
    event.preventDefault();
    changeParameter(
      spec,
      Math.max(
        spec.min,
        Math.min(spec.max, Number((parameters[spec.key] + direction * spec.step).toFixed(10))),
      ),
    );
  });
  number.addEventListener('input', () => readNumber(spec, false));
  number.addEventListener('change', () => readNumber(spec, true));
  number.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      readNumber(spec, true);
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      syncControl(spec);
    }
  });
}
function setControlError(spec, message = '') {
  const number = $(`number-${spec.key}`),
    error = $(`error-${spec.key}`);
  number.setAttribute('aria-invalid', String(Boolean(message)));
  error.textContent = message;
  error.hidden = !message;
}
function syncControl(spec, preserveDraft = false) {
  $(`control-${spec.key}`).value = parameters[spec.key];
  if (!preserveDraft) $(`number-${spec.key}`).value = String(parameters[spec.key]);
  setControlError(spec);
}
function syncControls() {
  for (const spec of CONTROLS) syncControl(spec);
}
function changeParameter(spec, value, preserveDraft = false) {
  const changed = parameters[spec.key] !== value;
  parameters[spec.key] = value;
  syncControl(spec, preserveDraft);
  if (changed) {
    document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('selected'));
    scheduleCalculation();
  }
}
function readNumber(spec, commit) {
  const input = $(`number-${spec.key}`),
    value = input.valueAsNumber;
  if (!Number.isFinite(value)) {
    setControlError(spec, commit ? '数値を入力してください。' : '');
    return;
  }
  try {
    validateParameters({ [spec.key]: value }, parameters);
  } catch {
    setControlError(
      spec,
      spec.key === 'seed'
        ? `${spec.min}〜${spec.max}の整数を入力してください。`
        : `${spec.min}〜${spec.max}の範囲で入力してください。`,
    );
    return;
  }
  changeParameter(spec, value, !commit);
}
function scheduleCalculation() {
  clearTimeout(scheduled);
  scheduled = setTimeout(calculate, 35);
}
function calculate() {
  if (!calibration) return;
  try {
    flight = simulate(parameters, calibration);
    reference = simulate(parameters, calibration, { includeSide: false });
    fraction = 1;
    playing = false;
    updatePlayback();
    const final = flight.final;
    $('metric-side').innerHTML =
      `${final[1] >= 0 ? '+' : ''}${final[1].toFixed(2)}<small>m</small>`;
    $('metric-height').innerHTML = `${final[2].toFixed(2)}<small>m</small>`;
    $('metric-time').innerHTML = `${flight.duration.toFixed(2)}<small>s</small>`;
    $('metric-apex').innerHTML = `${flight.apex.toFixed(2)}<small>m</small>`;
    const goal = flight.ending === 'goal',
      onTarget =
        goal &&
        Math.abs(final[1]) <= 3.66 - parameters.diameter / 2 &&
        final[2] <= 2.44 - parameters.diameter / 2;
    $('ending-badge').textContent = goal
      ? onTarget
        ? 'ゴール枠内に到達'
        : `${parameters.distance} m地点に到達`
      : flight.ending === 'ground'
        ? flight.duration === 0
          ? '地面から離れません'
          : `${final[0].toFixed(1)} mで着地`
        : '計算時間の上限';
    $('ending-badge').classList.toggle('ground', !goal);
    updateWakeResponse();
    draw();
    drawForces();
  } catch (error) {
    $('ending-badge').textContent = error.message;
    $('ending-badge').classList.add('ground');
  }
}
function updateWakeResponse() {
  const enabled = parameters.knuckle > 0,
    retention = enabled ? flight.samples[0].wakeRetention : 0;
  $('wake-retention-value').textContent = enabled ? `${(100 * retention).toFixed(1)}%` : 'OFF';
  $('wake-retention-meter').value = retention;
  $('wake-retention-note').textContent = enabled
    ? '同じ流速の無回転時を100%とする、後流の横力振幅のモデル値です。'
    : '「後流の揺らぎ」が0のため、ブレによる横力は無効です。';
}
function draw() {
  renderer.draw({ parameters, flight, reference, view, camera, fraction });
}
function drawForces() {
  renderer.drawForces(flight, fraction);
}
function drawWake(now) {
  const caption = renderer.drawWake(now, wakeData, calibration);
  if (caption) $('wake-caption').textContent = caption;
}
function updatePlayback() {
  updateFlowLink();
  const canPlay = Boolean(flight && flight.duration > 0);
  $('play').disabled = !canPlay;
  $('timeline').disabled = !canPlay;
  $('play').textContent = playing ? 'Ⅱ 一時停止' : '▶ 再生';
  $('play').setAttribute('aria-label', playing ? '再生を一時停止' : '軌道を再生');
  $('timeline').value = fraction;
  $('playback-time').value = `${(fraction * (flight?.duration ?? 0)).toFixed(2)} s`;
}
function animate(now) {
  if (playing && flight?.duration > 0) {
    fraction +=
      (Math.min((now - lastTime) / 1000, 0.05) * Number($('playback-speed').value)) /
      flight.duration;
    if (fraction >= 1) {
      fraction = 1;
      playing = false;
    }
    updatePlayback();
    draw();
    drawForces();
  }
  if (analysis === 'wake') drawWake(now);
  lastTime = now;
  requestAnimationFrame(animate);
}

document.querySelectorAll('[data-preset]').forEach((button) =>
  button.addEventListener('click', () => {
    parameters = { ...parameters, ...PRESETS[button.dataset.preset] };
    document
      .querySelectorAll('[data-preset]')
      .forEach((b) => b.classList.toggle('selected', b === button));
    syncControls();
    calculate();
  }),
);
$('reset').addEventListener('click', () => {
  parameters = { ...DEFAULTS };
  syncControls();
  document
    .querySelectorAll('[data-preset]')
    .forEach((b) => b.classList.toggle('selected', b.dataset.preset === 'knuckle'));
  calculate();
});
document.querySelectorAll('[data-view]').forEach((button) =>
  button.addEventListener('click', () => {
    view = button.dataset.view;
    document
      .querySelectorAll('[data-view]')
      .forEach((b) => b.classList.toggle('selected', b === button));
    $('camera-hint').textContent =
      view === 'perspective'
        ? 'ドラッグで回転 · ホイールで拡大'
        : view === 'goal'
          ? '蹴る人からゴールを見る向き'
          : '距離・高さは同じ縮尺';
    draw();
  }),
);
document.querySelectorAll('[data-analysis]').forEach((button) =>
  button.addEventListener('click', () => {
    analysis = button.dataset.analysis;
    document
      .querySelectorAll('[data-analysis]')
      .forEach((b) => b.classList.toggle('selected', b === button));
    $('forces-panel').hidden = analysis !== 'forces';
    $('wake-panel').hidden = analysis !== 'wake';
    $('analysis-description').textContent =
      analysis === 'forces' ? '飛行中の抗力・横力・マグヌス力' : '計算済みの2次元流れ';
    if (analysis === 'forces') drawForces();
  }),
);
function toggleMobileControls(open) {
  $('controls').classList.toggle('mobile-open', open);
  $('mobile-controls').setAttribute('aria-expanded', String(open));
  if (open) {
    window.scrollTo({ top: 0, behavior: 'auto' });
    $('close-controls').focus({ preventScroll: true });
  } else $('mobile-controls').focus({ preventScroll: true });
}
$('mobile-controls').addEventListener('click', () => toggleMobileControls(true));
$('close-controls').addEventListener('click', () => toggleMobileControls(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && $('controls').classList.contains('mobile-open'))
    toggleMobileControls(false);
});
const buttonStates = new MutationObserver((records) => {
  for (const record of records) {
    const button = record.target;
    button.setAttribute('aria-pressed', String(button.classList.contains('selected')));
  }
});
document.querySelectorAll('[data-preset],[data-view],[data-analysis]').forEach((button) => {
  button.setAttribute('aria-pressed', String(button.classList.contains('selected')));
  buttonStates.observe(button, { attributes: true, attributeFilter: ['class'] });
});
$('play').addEventListener('click', () => {
  if (!flight || flight.duration <= 0) return;
  if (fraction >= 1) fraction = 0;
  playing = !playing;
  updatePlayback();
  draw();
});
$('restart').addEventListener('click', () => {
  fraction = 0;
  playing = false;
  updatePlayback();
  draw();
  drawForces();
});
$('timeline').addEventListener('input', (event) => {
  fraction = Number(event.target.value);
  playing = false;
  updatePlayback();
  draw();
  drawForces();
});
let pointer = null;
canvas.addEventListener('pointerdown', (event) => {
  if (view !== 'perspective') return;
  pointer = { x: event.clientX, y: event.clientY };
  canvas.setPointerCapture(event.pointerId);
});
canvas.addEventListener('pointermove', (event) => {
  if (!pointer) return;
  camera.yaw -= (event.clientX - pointer.x) * 0.007;
  camera.pitch = clampCameraPitch(camera.pitch + (event.clientY - pointer.y) * 0.005);
  pointer = { x: event.clientX, y: event.clientY };
  draw();
});
canvas.addEventListener('pointerup', () => (pointer = null));
canvas.addEventListener('pointercancel', () => (pointer = null));
canvas.addEventListener(
  'wheel',
  (event) => {
    if (view !== 'perspective') return;
    event.preventDefault();
    camera.zoom = Math.max(0.6, Math.min(2, camera.zoom * Math.exp(-event.deltaY * 0.001)));
    draw();
  },
  { passive: false },
);
canvas.addEventListener('keydown', (event) => {
  if (view !== 'perspective') return;
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
    event.preventDefault();
    camera.yaw += event.key === 'ArrowLeft' ? 0.1 : event.key === 'ArrowRight' ? -0.1 : 0;
    camera.pitch = clampCameraPitch(
      camera.pitch + (event.key === 'ArrowUp' ? 0.08 : event.key === 'ArrowDown' ? -0.08 : 0),
    );
    draw();
  }
});
new ResizeObserver(() => {
  draw();
  drawForces();
}).observe(canvas);
syncControls();
requestAnimationFrame(animate);
try {
  const response = await fetch('./calibration.json');
  if (!response.ok) throw new Error('計算データを読み込めませんでした。');
  calibration = await response.json();
  calculate();
  if (restoredFraction !== null) {
    fraction = restoredFraction;
    restoredFraction = null;
    updatePlayback();
    draw();
    drawForces();
  }
  fetch('./wake.bin')
    .then((r) => {
      if (!r.ok) throw new Error('後流データの読み込みに失敗しました。');
      return r.arrayBuffer();
    })
    .then((buffer) => (wakeData = new Int8Array(buffer)))
    .catch((error) => ($('wake-caption').textContent = error.message));
} catch (error) {
  $('ending-badge').textContent = error.message;
  $('ending-badge').classList.add('ground');
}

// Feature-detected WebMCP: the same validated settings/actions as the sliders.
if (document.modelContext?.registerTool) {
  const lifecycle = new AbortController();
  window.addEventListener('pagehide', () => lifecycle.abort(), { once: true });
  const properties = Object.fromEntries(
    CONTROLS.map((s) => [
      s.key,
      {
        type: s.key === 'seed' ? 'integer' : 'number',
        minimum: s.min,
        maximum: s.max,
        description: `${s.label} [${s.unit}]`,
      },
    ]),
  );
  for (const tool of [
    {
      name: 'get_flight_simulation',
      description: '現在のキック設定と飛行結果を読み取る。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
      execute: () => ({
        parameters,
        ending: flight?.ending,
        duration: flight?.duration,
        finalPosition: flight?.final.slice(0, 3),
        apex: flight?.apex,
      }),
    },
    {
      name: 'configure_flight_simulation',
      description: '回転数、回転軸、初速、風などを変更し、表示中の軌道を再計算する。',
      inputSchema: { type: 'object', properties, additionalProperties: false },
      annotations: { readOnlyHint: false },
      execute: (input) => {
        if (!calibration) throw new Error('計算データの読み込み中です。');
        parameters = validateParameters(input, parameters);
        document.querySelectorAll('[data-preset]').forEach((b) => b.classList.remove('selected'));
        syncControls();
        calculate();
        return {
          parameters,
          ending: flight.ending,
          duration: flight.duration,
          finalPosition: flight.final.slice(0, 3),
        };
      },
    },
  ]) {
    try {
      Promise.resolve(document.modelContext.registerTool(tool, { signal: lifecycle.signal })).catch(
        () => {},
      );
    } catch {}
  }
}
