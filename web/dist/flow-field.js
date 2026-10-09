// Pure interpretation of GPU slices, shared by the renderer and CSV export.
// Each cell stores [ux, uy, uz, rho] in lattice units. rho <= 0 marks the sphere.
export function planeData(frame, g, plane) {
  const offset = plane === 'xy' ? 0 : plane === 'xz' ? g.nx * g.ny : g.nx * (g.ny + g.nz),
    w = plane === 'yz' ? g.ny : g.nx,
    h = plane === 'xy' ? g.ny : g.nz;
  const a = plane === 'yz' ? 1 : 0,
    b = plane === 'xy' ? 1 : 2,
    data = frame.fields.subarray(offset * 4, (offset + w * h) * 4);
  return { data, w, h, a, b };
}
export function scalarAt(p, i, type, g, condition) {
  const { data, w, h, a, b } = p,
    k = i * 4;
  if (data[k + 3] <= 0) return null;
  if (type === 'speed')
    return (Math.hypot(data[k], data[k + 1], data[k + 2]) * condition.speed) / g.u;
  if (type === 'pressure') return (2 * (data[k + 3] - 1)) / (3 * g.u * g.u);
  const x = i % w,
    y = Math.floor(i / w);
  if (x === 0 || x === w - 1 || y === 0 || y === h - 1) return undefined;
  const neighbors = [i - 1, i + 1, i - w, i + w];
  if (neighbors.some((j) => data[4 * j + 3] <= 0)) return undefined;
  return (
    ((data[(i + 1) * 4 + b] -
      data[(i - 1) * 4 + b] -
      (data[(i + w) * 4 + a] - data[(i - w) * 4 + a])) *
      0.5 *
      g.d) /
    g.u
  );
}
export function fieldColor(value, type, limit) {
  if (value === null) return [23, 37, 46];
  if (value === undefined) return [205, 213, 219];
  if (type === 'speed') {
    const t = Math.max(0, Math.min(1, value / limit)),
      stops = [
        [12, 31, 49],
        [33, 111, 152],
        [89, 203, 191],
        [242, 232, 126],
      ],
      j = Math.min(2, Math.floor(t * 3)),
      f = t * 3 - j;
    return stops[j].map((v, k) => Math.round(v * (1 - f) + stops[j + 1][k] * f));
  }
  const t = Math.min(1, Math.abs(value) / limit),
    end = value >= 0 ? [178, 24, 43] : [33, 102, 172];
  return end.map((v) => Math.round(245 + (v - 245) * t));
}

export function sliceCSV(result, frame, plane) {
  const f = frame,
    g = result.config,
    p = planeData(frame, g, plane);
  const lines = [
    `# D3Q19 regularized Smagorinsky LES; smooth sphere; plane=${plane}`,
    `# flight_time_s=${result.condition.flightTime}; cfd_time_s=${f.step * g.dt}; Re=${g.re}; dx_m=${g.dx}; U_m_s=${result.condition.speed}`,
    `# omega_local_rad_s=${result.condition.omega.join(';')}; diameter_m=${result.condition.diameter}; grid=${g.nx}x${g.ny}x${g.nz}; tau=${g.tau}; Cs=${g.cs}`,
    'a_over_D,b_over_D,ux_m_s,uy_m_s,uz_m_s,rho_lattice,omega_normal_D_over_U,solid',
  ];
  for (let i = 0; i < p.w * p.h; i++) {
    const k = i * 4;
    lines.push(
      [
        ((i % p.w) - (plane === 'yz' ? g.cy : g.cx)) / g.d,
        (Math.floor(i / p.w) - (plane === 'xy' ? g.cy : g.cz)) / g.d,
        ...[0, 1, 2].map((j) => (p.data[k + j] * result.condition.speed) / g.u),
        p.data[k + 3],
        scalarAt(p, i, 'vorticity', g, result.condition) ?? '',
        p.data[k + 3] <= 0 ? 1 : 0,
      ].join(','),
    );
  }
  return lines.join('\n');
}
