import { dot, cross, unit } from './physics.js?v=3';
import { sizeCanvas } from './canvas.js';

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
    const t = fraction * flight.duration;
    let i = flight.samples.findIndex((p) => p.t >= t);
    if (i <= 0) return flight.samples[0].state;
    const a = flight.samples[i - 1],
      b = flight.samples[i],
      f = (t - a.t) / (b.t - a.t);
    return a.state.map((v, k) => v + f * (b.state[k] - v));
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
        '#29474b',
        1,
      );
    for (let y = -10; y <= 10; y += 2)
      pathLine(
        [
          [0, y, 0],
          [distance + 5, y, 0],
        ],
        project,
        '#223e43',
        1,
      );
    pathLine(
      [
        [0, 0, 0],
        [distance, 0, 0],
      ],
      project,
      '#557d7d',
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
      '#486664',
      1,
    );
    ctx.font = '12px "DM Sans",sans-serif';
    ctx.fillStyle = '#779b9f';
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
        '#385555',
        0.7,
      );
    for (let z = 0; z <= 2.45; z += 0.61)
      pathLine(
        [
          [distance + 1.5, -3.66, z],
          [distance + 1.5, 3.66, z],
        ],
        project,
        '#385555',
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
      '#d0dbd4',
      2.2,
    );
    pathLine(
      reference.samples.map((p) => p.state),
      project,
      '#7b969d',
      1.5,
      [5, 6],
    );
    const all = flight.samples.map((p) => p.state);
    pathLine(all, project, '#36635e', 1.5);
    const visible = flight.samples
        .filter((p) => p.t <= fraction * flight.duration)
        .map((p) => p.state),
      current = currentPoint(flight, fraction);
    visible.push(current);
    // Ground projection makes vertical and lateral deflection distinguishable.
    pathLine(
      visible.map((p) => [p[0], p[1], 0]),
      project,
      '#58c3ac55',
      1.5,
      [3, 4],
    );
    ctx.shadowColor = '#6de9d1';
    ctx.shadowBlur = 9;
    pathLine(visible, project, '#6de9d1', 2.7);
    ctx.shadowBlur = 0;
    const end = project(flight.final);
    ctx.beginPath();
    ctx.arc(...end, 5, 0, Math.PI * 2);
    ctx.strokeStyle = '#ffb876';
    ctx.lineWidth = 1.7;
    ctx.stroke();
    const position = project(current),
      ground = project([current[0], current[1], 0]);
    pathLine([current, [current[0], current[1], 0]], project, '#6de9d155', 1, [3, 5]);
    ctx.fillStyle = '#060f1577';
    ctx.beginPath();
    ctx.ellipse(ground[0], ground[1], 8, 3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(...position);
    ctx.rotate(2 * Math.PI * parameters.spin * fraction * flight.duration);
    ctx.beginPath();
    ctx.arc(0, 0, 6, 0, Math.PI * 2);
    ctx.fillStyle = '#f4f9f6';
    ctx.fill();
    ctx.strokeStyle = '#08242a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(-5, 0);
    ctx.lineTo(5, 0);
    ctx.stroke();
    ctx.restore();
    const label = project([distance, 0, 2.9]);
    ctx.fillStyle = '#b1c7c5';
    ctx.font = '12px "DM Sans",sans-serif';
    ctx.fillText(`${distance} m / GOAL`, label[0], label[1] - 4);
  }
  function drawForces(flight, fraction) {
    if (!flight) return;
    const { c, w, h } = sizeCanvas(forcesCanvas);
    c.clearRect(0, 0, w, h);
    const left = 40,
      right = w - 14,
      top = 12,
      bottom = h - 25;
    const values = flight.samples.flatMap((s) => [s.cd, s.cl, s.cm]),
      min = Math.min(-0.1, ...values) - 0.025,
      max = Math.max(0.5, ...values) + 0.025;
    const px = (t) => left + (t / flight.duration) * (right - left),
      py = (v) => bottom - ((v - min) / (max - min)) * (bottom - top);
    c.font = '11px "DM Sans",sans-serif';
    c.textAlign = 'right';
    for (let i = 0; i <= 4; i++) {
      const v = min + (i * (max - min)) / 4,
        y = py(v);
      c.strokeStyle = '#293b47';
      c.beginPath();
      c.moveTo(left, y);
      c.lineTo(right, y);
      c.stroke();
      c.fillStyle = '#90a5b3';
      c.fillText(v.toFixed(2), left - 8, y + 4);
    }
    for (let i = 0; i <= 4; i++) {
      const t = (i * flight.duration) / 4;
      c.textAlign = 'center';
      c.fillText(`${t.toFixed(1)}s`, px(t), h - 5);
    }
    for (const [key, color] of [
      ['cd', '#6de9d1'],
      ['cl', '#ffb876'],
      ['cm', '#9b9eff'],
    ]) {
      c.beginPath();
      flight.samples.forEach((s, i) => {
        const x = px(s.t),
          y = py(s[key]);
        i ? c.lineTo(x, y) : c.moveTo(x, y);
      });
      c.strokeStyle = color;
      c.lineWidth = 1.7;
      c.stroke();
    }
    c.beginPath();
    c.moveTo(px(fraction * flight.duration), top);
    c.lineTo(px(fraction * flight.duration), bottom);
    c.strokeStyle = '#d7e5e780';
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
