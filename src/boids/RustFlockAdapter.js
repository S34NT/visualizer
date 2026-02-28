import initWasm, { FlockSim, SimParams } from '../../rust/boids-wasm/pkg/boids_wasm.js';

/**
 * Minimal wrapper that mirrors the existing JS Flock API.
 * Intended to let main.js swap imports from ./Flock.js to this adapter.
 */
export class RustFlockAdapter {
  static async create(count, bounds, params) {
    await initWasm();
    return new RustFlockAdapter(count, bounds, params);
  }

  constructor(count, bounds, params) {
    this.bounds = bounds;
    this.params = params;
    this.sim = new FlockSim(count, bounds, this.#toSimParams(params));
  }

  setCount(newCount) {
    this.sim.set_count(newCount);
  }

  reset() {
    this.sim.reset();
  }

  update(params) {
    this.params = params;
    this.sim.set_params(this.#toSimParams(params));
    this.sim.update();
  }

  getPositions() {
    return this.sim.positions();
  }

  get count() {
    return this.sim.count();
  }

  #toSimParams(params) {
    return new SimParams(
      params.visualRange,
      params.protectedRange,
      params.centeringFactor,
      params.avoidFactor,
      params.matchingFactor,
      params.maxSpeed,
      params.minSpeed,
      params.turnFactor,
      params.margin
    );
  }
}
