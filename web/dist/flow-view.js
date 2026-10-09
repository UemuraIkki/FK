import { sizeCanvas } from './canvas.js';
import { planeData, scalarAt, fieldColor } from './flow-field.js';

export function drawFlightPreview(canvas, flight, fraction) {
  const { c, w, h } = sizeCanvas(canvas, { reset: true }),
    samples = flight.samples;
  const xmax = Math.max(1, ...samples.map((s) => Math.abs(s.state[0]))),
    zmax = Math.max(1, ...samples.map((s) => s.state[2]));
  const px = (x) => 16 + ((w - 32) * x) / xmax,
    py = (z) => h - 22 - ((h - 40) * z) / zmax;
  c.strokeStyle = '#1e293b';
  c.beginPath();
  c.moveTo(16, h - 22);
  c.lineTo(w - 16, h - 22);
  c.stroke();
  c.strokeStyle = '#22d3ee';
  c.lineWidth = 2.2;
  c.beginPath();
  samples.forEach((s, i) =>
    i ? c.lineTo(px(s.state[0]), py(s.state[2])) : c.moveTo(px(s.state[0]), py(s.state[2])),
  );
  c.stroke();
  const s = samples.reduce((a, b) =>
    Math.abs(b.t - fraction * flight.duration) < Math.abs(a.t - fraction * flight.duration) ? b : a,
  );
  c.fillStyle = '#ffffff';
  c.beginPath();
  c.arc(px(s.state[0]), py(s.state[2]), 4.5, 0, Math.PI * 2);
  c.fill();
  c.font = '10px ui-monospace, "SF Mono", "Geist Mono", monospace';
  c.fillStyle = '#64748b';
  c.fillText('側面 / 距離 x・高さ z', 16, h - 6);
}

/** Owns canvas resources; receives a snapshot of application state on each draw. */
export function createFlowRenderer(plot) {
  const ctx = plot.getContext('2d'),
    raster = plot.ownerDocument.createElement('canvas');
  function draw({ result, frame, plane, type, showVectors }) {
    const { w, h } = sizeCanvas(plot, { reset: true });
    ctx.clearRect(0, 0, w, h);
    if (!frame) return;
    const g = result.config,
      p = planeData(frame, g, plane),
      limit = type === 'speed' ? result.condition.speed * 1.6 : type === 'pressure' ? 1.5 : 2;
    raster.width = p.w;
    raster.height = p.h;
    const rc = raster.getContext('2d'),
      image = rc.createImageData(p.w, p.h);
    for (let i = 0; i < p.w * p.h; i++) {
      const rgb = fieldColor(scalarAt(p, i, type, g, result.condition), type, limit),
        x = i % p.w,
        y = Math.floor(i / p.w),
        k = ((p.h - 1 - y) * p.w + x) * 4;
      image.data.set([...rgb, 255], k);
    }
    rc.putImageData(image, 0, 0);
    const scale = Math.min((w - 62) / p.w, (h - 58) / p.h),
      width = p.w * scale,
      height = p.h * scale,
      left = (w - width) / 2,
      top = (h - height) / 2 - 5;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(raster, left, top, width, height);
    if (showVectors) {
      ctx.strokeStyle = type === 'speed' ? '#f0f9faaa' : '#173140a0';
      ctx.lineWidth = 0.9;
      const stride = Math.max(4, Math.round(p.w / 28));
      for (let y = stride; y < p.h - stride; y += stride)
        for (let x = stride; x < p.w - stride; x += stride) {
          const k = (y * p.w + x) * 4;
          if (p.data[k + 3] <= 0) continue;
          const u = p.data[k + p.a] / g.u,
            v = p.data[k + p.b] / g.u,
            mag = Math.hypot(u, v);
          if (mag < 0.025) continue;
          const len = Math.min(stride * scale * 0.75, mag * stride * scale * 0.42),
            dx = (u / mag) * len,
            dy = (-v / mag) * len,
            px = left + (x + 0.5) * scale,
            py = top + (p.h - y - 0.5) * scale;
          ctx.beginPath();
          ctx.moveTo(px - dx * 0.5, py - dy * 0.5);
          ctx.lineTo(px + dx * 0.5, py + dy * 0.5);
          ctx.lineTo(px + dx * 0.5 - dx * 0.23 + dy * 0.16, py + dy * 0.5 - dy * 0.23 - dx * 0.16);
          ctx.moveTo(px + dx * 0.5, py + dy * 0.5);
          ctx.lineTo(px + dx * 0.5 - dx * 0.23 - dy * 0.16, py + dy * 0.5 - dy * 0.23 + dx * 0.16);
          ctx.stroke();
        }
    }
    ctx.font = '12px sans-serif';
    ctx.fillStyle = '#9cb3c1';
    ctx.textAlign = 'center';
    const centerX = plane === 'yz' ? g.cy : g.cx,
      centerY = plane === 'xy' ? g.cy : g.cz;
    for (let x = 0; x < p.w; x += g.d) {
      const px = left + (x + 0.5) * scale;
      ctx.fillText(((x - centerX) / g.d).toFixed(1), px, top + height + 18);
    }
    ctx.textAlign = 'right';
    for (let y = g.d / 2; y < p.h; y += g.d)
      ctx.fillText(((y - centerY) / g.d).toFixed(1), left - 7, top + (p.h - y) * scale + 4);
    ctx.textAlign = 'left';
    ctx.fillText(plane === 'yz' ? 'η / D' : 'ξ / D（下流方向）', left, top + height + 35);
    ctx.fillText(plane === 'xy' ? 'η / D' : 'ζ / D', left, Math.max(14, top - 12));
    return {
      min: type === 'speed' ? '0' : `−${limit}`,
      max: type === 'speed' ? limit.toFixed(1) : `+${limit}`,
      gradient: type === 'speed' ? 'linear-gradient(90deg,#0c1f31,#216f98,#59cbbf,#f2e87e)' : '',
      unit:
        type === 'speed'
          ? 'm/s'
          : type === 'pressure'
            ? 'Cp'
            : plane === 'xy'
              ? 'ωζ D/U'
              : plane === 'xz'
                ? '−ωη D/U'
                : 'ωξ D/U',
      caption:
        plane === 'yz'
          ? '球の中心から下流2Dの断面。η・ζは相対風に直交する方向です。'
          : '球の中心を通る断面。ξは相対風の下流方向、ζは鉛直上方を相対風に直交投影した方向です。',
    };
  }
  return { draw };
}
