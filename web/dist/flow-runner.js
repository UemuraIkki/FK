import { GPULBM } from './lbm-gpu.js';

const BATCH_STEPS = 32;
const MAX_SNAPSHOTS = 64;
const PROGRESS_INTERVAL_SECONDS = 0.35;

/**
 * Owns a CFD run and its GPU lifetime, independently of the page.
 * Only complete runs enter the bounded cache. Cancellation retains partial frames.
 * The solver and clock can be injected to verify lifecycle behavior without a GPU.
 */
export class FlowRunner {
  constructor({
    createSolver = (config) => GPULBM.create(config),
    now = () => performance.now(),
    cacheLimit = 2,
  } = {}) {
    this.createSolver = createSolver;
    this.now = now;
    this.cacheLimit = cacheLimit;
    this.cache = new Map();
    this.running = false;
    this.cancelRequested = false;
  }

  getCached(key) {
    return this.cache.get(key);
  }
  cancel() {
    this.cancelRequested = true;
  }

  async run(
    { key, condition, config },
    { onStart = () => {}, onFrame = () => {}, onProgress = () => {} } = {},
  ) {
    if (this.running) throw new Error('CFD計算はすでに実行中です。');
    this.running = true;
    this.cancelRequested = false;
    const result = {
      key,
      condition: structuredClone(condition),
      config: structuredClone(config),
      frames: [],
      complete: false,
    };
    const start = this.now();
    let solver;
    try {
      onStart(result);
      solver = await this.createSolver(result.config);
      const steps = result.config.steps;
      const interval = Math.max(MAX_SNAPSHOTS, Math.ceil(steps / MAX_SNAPSHOTS));
      let nextSnapshot = 1,
        lastUpdate = 0;
      while (solver.stepCount < steps && !this.cancelRequested) {
        await solver.advance(Math.min(BATCH_STEPS, steps - solver.stepCount));
        const elapsed = (this.now() - start) / 1000;
        const progress = solver.stepCount / steps;
        if (solver.stepCount >= nextSnapshot || solver.stepCount === steps) {
          const snapshot = await solver.snapshot();
          result.frames.push(snapshot);
          onFrame(snapshot, result);
          nextSnapshot = solver.stepCount + interval;
        }
        if (elapsed - lastUpdate > PROGRESS_INTERVAL_SECONDS || solver.stepCount === steps) {
          onProgress({ step: solver.stepCount, steps, elapsed, progress });
          lastUpdate = elapsed;
        }
        // advance() awaits the GPU queue and leaves the UI responsive.
      }
      result.complete = !this.cancelRequested;
      result.elapsed = (this.now() - start) / 1000;
      if (result.complete) {
        this.cache.set(key, result);
        while (this.cache.size > this.cacheLimit) this.cache.delete(this.cache.keys().next().value);
      }
      return result;
    } catch (error) {
      result.failed = true;
      throw error;
    } finally {
      try {
        solver?.destroy();
      } finally {
        this.running = false;
      }
    }
  }
}
