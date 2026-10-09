import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DEFAULTS, simulate } from './dist/physics.js';
import { createFlightRenderer } from './dist/flight-view.js';
import { drawFlightPreview } from './dist/flow-view.js';

const calibration = JSON.parse(
  fs.readFileSync(new URL('./dist/calibration.json', import.meta.url)),
);
function canvas() {
  const calls = [];
  const context = new Proxy(
    {},
    {
      get:
        (_, name) =>
        (...args) => {
          for (const value of args)
            if (typeof value === 'number')
              assert.ok(Number.isFinite(value), `${String(name)}(${args})`);
          calls.push({ name, args });
        },
    },
  );
  return {
    calls,
    getContext: () => context,
    getBoundingClientRect: () => ({ width: 600, height: 360 }),
  };
}

test('Grounded zero-duration flights render finite coordinates in every view', () => {
  const parameters = { ...DEFAULTS, elevation: 0, knuckle: 0 },
    flight = simulate(parameters, calibration),
    plot = canvas(),
    forces = canvas(),
    wake = canvas(),
    renderer = createFlightRenderer(plot, forces, wake);
  assert.equal(flight.duration, 0);
  for (const view of ['perspective', 'top', 'side', 'goal'])
    for (const fraction of [0, 0.5, 1]) {
      renderer.draw({
        parameters,
        flight,
        reference: flight,
        view,
        fraction,
        camera: { yaw: -2.18, pitch: 0.66, zoom: 1 },
      });
      renderer.drawForces(flight, fraction);
      drawFlightPreview(canvas(), flight, fraction);
    }
  assert.ok(forces.calls.some((c) => c.name === 'fillText' && c.args[0] === '空中飛行なし'));
});

test('Flight view and CFD preview interpolate a mid-flight position between samples', () => {
  const flight = {
    duration: 2,
    apex: 1.1,
    final: [10, 0, 1.1],
    samples: [
      { t: 0, state: [0, 0, 0.1] },
      { t: 2, state: [10, 0, 1.1] },
    ],
  };
  const plot = canvas(),
    renderer = createFlightRenderer(plot, canvas(), canvas());
  renderer.draw({ parameters: DEFAULTS, flight, reference: flight, view: 'side', fraction: 0.25 });
  const ball = plot.calls.find((c) => c.name === 'translate').args,
    scale = Math.min(530 / 35, 245 / 7);
  assert.ok(Math.abs(ball[0] - (300 + (2.5 - 15) * scale)) < 1e-10);
  assert.ok(Math.abs(ball[1] - (295 - 0.35 * scale)) < 1e-10);
  const preview = canvas();
  drawFlightPreview(preview, flight, 0.25);
  const point = preview.calls.find((c) => c.name === 'arc').args;
  assert.ok(Math.abs(point[0] - (16 + 568 * 0.25)) < 1e-10);
  assert.ok(Math.abs(point[1] - (338 - (320 * 0.35) / 1.1)) < 1e-10);
});
