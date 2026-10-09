import { dot, cross, unit } from './physics.js?v=4';
import { sizeCanvas } from './canvas.js';
import { sampleFlight } from './flow-state.js?v=2';

/** Renders flight, force history, and the precomputed wake without owning simulation state. */
export function createFlightRenderer(canvas, forcesCanvas, wakeCanvas) {
  const ctx = canvas.getContext('2d');
  function projection(w, h, { parameters, flight, reference, view, camera }) {
    const distance = parameters.distance;
    if (view === 'top') {
      const lateral = Math.max(8, ...flight.samples.map((p) => Math.abs(p.state[1]) + 2));
      const scale = Math.min((w - 70) / (distance + 5), (h - 115) / (2 * lateral));
      return (p) => [w / 2 + (p[0] - distance / 2) * scale, h / 2 + 14 - p[1] * scale];
    }
    if (view === 'side') {
      const top = Math.max(7, flight.apex + 1);
      const scale = Math.min((w - 70) / (distance + 5), (h - 115) / top);
      return (p) => [w / 2 + (p[0] - distance / 2) * scale, h - 65 - p[2] * scale];
    }
    if (view === 'goal') {
      const lateral = Math.max(5, Math.abs(flight.final[1]) + 1),
        top = Math.max(4, flight.apex + 1);
      const scale = Math.min((w - 70) / (2 * lateral), (h - 115) / top);
      return (p) => [w / 2 + p[1] * scale, h - 65 - p[2] * scale];
    }
    const target = [distance * 0.48, 0, 1.1];
    const points = [
      ...flight.samples.map((p) => p.state),
      ...reference.samples.map((p) => p.state),
      [distance, -3.66, 0],
      [distance, 3.66, 2.44],
    ];
    // Tall or sideways kicks must stay in front of the orbit camera at every angle.
    const sceneRadius = Math.max(
      ...points.map((p) => Math.hypot(p[0] - target[0], p[1] - target[1], p[2] - target[2])),
    );
    const radius = Math.max(34, distance * 1.15, sceneRadius * 1.2);
    const eye = [
      target[0] + radius * Math.cos(camera.pitch) * Math.cos(camera.yaw),
      radius * Math.cos(camera.pitch) * Math.sin(camera.yaw),
      target[2] + radius * Math.sin(camera.pitch),
    ];
    const forward = unit(target.map((v, i) => v - eye[i])),
      right = unit(cross(forward, [0, 0, 1])),
      up = cross(right, forward);
    const raw = (p) => {
      const d = [p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]],
        depth = Math.max(2, dot(d, forward));
      return [dot(d, right) / depth, dot(d, up) / depth];
    };
    const bounds = points.map(raw);
    const xmin = Math.min(...bounds.map((p) => p[0])),
      xmax = Math.max(...bounds.map((p) => p[0])),
      ymin = Math.min(...bounds.map((p) => p[1])),
      ymax = Math.max(...bounds.map((p) => p[1]));
    const focal =
      Math.min(
        w * 1.2,
        h * 2,
        (w - 60) / Math.max(xmax - xmin, 0.01),
        (h - 125) / Math.max(ymax - ymin, 0.01),
      ) * camera.zoom;
    return (p) => {
      const v = raw(p);
      return [
        w / 2 + focal * (v[0] - (xmin + xmax) / 2),
        (h + 10) / 2 - focal * (v[1] - (ymin + ymax) / 2),
      ];
    };
  }
  function pathLine(points, project, color, width = 1, dash = []) {
    if (points.length < 2) return;
    ctx.beginPath();
    points.forEach((p, i) => {
      const [x, y] = project(p);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  function currentPoint(flight, fraction) {
    if (!flight) return null;
    return sampleFlight(flight, fraction).state;
  }
  function draw(state) {
    const { parameters, flight, reference, view, camera, fraction } = state;
    const { w, h } = sizeCanvas(canvas);
    ctx.clearRect(0, 0, w, h);
    if (!flight) return;
    const project = projection(w, h, state),
      distance = parameters.distance;
    for (let x = 0; x <= distance + 5; x += 5)
      pathLine(
        [
          [x, -10, 0],
          [x, 10, 0],
        ],
        project,
        '#1e293b',
        1,
      );
    for (let y = -10; y <= 10; y += 2)
      pathLine(
        [
          [0, y, 0],
          [distance + 5, y, 0],
        ],
        project,
        '#162231',
        1,
      );
    pathLine(
      [
        [0, 0, 0],
        [distance, 0, 0],
      ],
      project,
      '#334155',
      1,
      [3, 5],
    );
    pathLine(
      [
        [0, -10, 0],
        [distance + 5, -10, 0],
        [distance + 5, 10, 0],
        [0, 10, 0],
        [0, -10, 0],
      ],
      project,
      '#334155',
      1,
    );
    ctx.font = '11px ui-monospace, "SF Mono", "Geist Mono", monospace';
    ctx.fillStyle = '#64748b';
    ctx.textAlign = 'center';
    if (view !== 'goal')
      for (let x = 0; x <= distance; x += 10) {
        const p = project([x, -10.7, 0]);
        ctx.fillText(`${x} m`, p[0], p[1]);
      }
    // Regulation goal opening; the displayed lines are a geometric scale reference.
    for (let y = -3.66; y <= 3.67; y += 0.61)
      pathLine(
        [
          [distance + 1.5, y, 0],
          [distance + 1.5, y, 2.44],
          [distance, y, 2.44],
        ],
        project,
        '#334155',
        0.7,
      );
    for (let z = 0; z <= 2.45; z += 0.61)
      pathLine(
        [
          [distance + 1.5, -3.66, z],
          [distance + 1.5, 3.66, z],
        ],
        project,
        '#334155',
        0.7,
      );
    pathLine(
      [
        [distance, -3.66, 0],
        [distance, -3.66, 2.44],
        [distance, 3.66, 2.44],
        [distance, 3.66, 0],
      ],
      project,
      '#f1f5f9',
      2.2,
    );
    pathLine(
      reference.samples.map((p) => p.state),
      project,
      '#64748b',
      1.5,
      [5, 6],
    );
    const all = flight.samples.map((p) => p.state);
    pathLine(all, project, 'rgba(56, 189, 248, 0.2)', 1.5);
    const start = project(all[0]);
    ctx.beginPath();
    ctx.arc(...start, 4, 0, Math.PI * 2);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#94a3b8';
    ctx.textAlign = 'left';
    ctx.font = '12px sans-serif';
    ctx.fillText(
      `キック · 底面 ${parameters.launchHeight.toFixed(2)} m`,
      start[0] + 10,
      start[1] - 12,
    );
    ctx.textAlign = 'center';
    const visible = flight.samples
        .filter((p) => p.t <= fraction * flight.duration)
        .map((p) => p.state),
      current = currentPoint(flight, fraction);
    visible.push(current);
    // Ground projection makes vertical and lateral deflection distinguishable.
    pathLine(
      visible.map((p) => [p[0], p[1], 0]),
      project,
      'rgba(56, 189, 248, 0.25)',
      1.5,
      [3, 4],
    );
    ctx.shadowColor = 'rgba(34, 211, 238, 0.8)';
    ctx.shadowBlur = 10;
    pathLine(visible, project, '#22d3ee', 2.8);
    ctx.shadowBlur = 0;
    const end = project(flight.final);
    ctx.beginPath();
    ctx.arc(...end, 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#f59e0b';
    ctx.lineWidth = 2;
    ctx.stroke();
    const position = project(current),
      ground = project([current[0], current[1], 0]);
    pathLine([current, [current[0], current[1], 0]], project, 'rgba(34, 211, 238, 0.4)', 1, [3, 5]);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.beginPath();
    ctx.ellipse(ground[0], ground[1], 8, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(...position);
    ctx.rotate(2 * Math.PI * parameters.spin * fraction * flight.duration);
    ctx.beginPath();
    ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.strokeStyle = '#0f172a';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(-5.5, 0);
    ctx.lineTo(5.5, 0);
    ctx.stroke();
    ctx.restore();
    const label = project([distance, 0, 2.9]);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '11px ui-monospace, "SF Mono", "Geist Mono", monospace';
    ctx.fillText(`${distance} m / GOAL`, label[0], label[1] - 4);
  }
  function drawForces(flight, fraction) {
    if (!flight) return;
    const { c, w, h } = sizeCanvas(forcesCanvas);
    c.clearRect(0, 0, w, h);
    if (flight.duration <= 0) {
      c.font = '14px sans-serif';
      c.fillStyle = '#94a3b8';
      c.textAlign = 'center';
      c.fillText('空中飛行なし', w / 2, h / 2 - 10);
      c.fillText('蹴り上げ角度か高さを上げてください。', w / 2, h / 2 + 16);
      return;
    }
    const left = 40,
      right = w - 14,
      top = 12,
      bottom = h - 25;
    const values = flight.samples.flatMap((s) => [s.cd, s.cl, s.cm]),
      min = Math.min(-0.1, ...values) - 0.025,
      max = Math.max(0.5, ...values) + 0.025;
    const px = (t) => left + (t / flight.duration) * (right - left),
      py = (v) => bottom - ((v - min) / (max - min)) * (bottom - top);
    c.font = '10px ui-monospace, "SF Mono", "Geist Mono", monospace';
    c.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = min + (i * (max - min)) / 4,
        y = py(v);
      c.strokeStyle = '#1e293b';
      c.beginPath();
      c.moveTo(left, y);
      c.lineTo(right, y);
      c.stroke();
      c.fillStyle = '#64748b';
      c.fillText(v.toFixed(2), left - 8, y + 4);
    }
    for (let i = 0; i <= 4; i++) {
      const t = (i * flight.duration) / 4;
      c.textAlign = 'center';
      c.fillText(`${t.toFixed(1)}s`, px(t), h - 5);
    }
    for (const [key, color] of [
      ['cd', '#22d3ee'],
      ['cl', '#fb923c'],
      ['cm', '#818cf8'],
    ]) {
      c.beginPath();
      flight.samples.forEach((s, i) => {
        const x = px(s.t),
          y = py(s[key]);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      c.strokeStyle = color;
      c.lineWidth = 1.8;
      c.stroke();
    }
    c.beginPath();
    c.moveTo(px(fraction * flight.duration), top);
    c.lineTo(px(fraction * flight.duration), bottom);
    c.strokeStyle = 'rgba(255, 255, 255, 0.4)';
    c.setLineDash([3, 4]);
    c.stroke();
    c.setLineDash([]);
  }
  function drawWake(now, wakeData, calibration) {
    if (!wakeData || !calibration) return;
    const meta = calibration.wakeFrames,
      element = wakeCanvas;
    if (element.width !== meta.width || element.height !== meta.height) {
      element.width = meta.width;
      element.height = meta.height;
    }
    const c = element.getContext('2d'),
      image = c.createImageData(meta.width, meta.height),
      frame = Math.floor(now / 110) % meta.frames;
    for (let i = 0; i < meta.width * meta.height; i++) {
      const v = wakeData[frame * meta.width * meta.height + i];
      let color;
      if (v === -128) color = [93, 105, 112];
      else {
        const t = Math.min(1, Math.abs(v) / 100),
          end = v > 0 ? [184, 38, 51] : [32, 96, 163];
        color = end.map((n) => Math.round(238 + (n - 238) * t));
      }
      const y = Math.floor(i / meta.width),
        x = i % meta.width,
        j = ((meta.height - 1 - y) * meta.width + x) * 4;
      image.data.set([...color, 255], j);
    }
    c.putImageData(image, 0, 0);
    return `参照CFD：Re = 86.4 / step ${meta.steps[frame].toLocaleString()} / 渦度 ωD/U₀（青 −2.5、白 0、赤 +2.5）。スライダーでは飛行モデルだけを再計算します。`;
  }
  return { draw, drawForces, drawWake };
}
