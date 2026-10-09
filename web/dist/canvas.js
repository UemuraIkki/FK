/** Size a 2D canvas in CSS pixels while accounting for the display pixel ratio. */
export function sizeCanvas(canvas, { reset = false } = {}) {
  const rect = canvas.getBoundingClientRect();
  const pixelRatio = Math.min(globalThis.devicePixelRatio || 1, 2);
  const width = Math.round(rect.width * pixelRatio);
  const height = Math.round(rect.height * pixelRatio);
  if (reset || canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  return { c: context, w: rect.width, h: rect.height };
}
