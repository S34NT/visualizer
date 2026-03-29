let wasmModulePromise = null;

async function loadWasmModule() {
  if (!wasmModulePromise) {
    const dynamicImport = new Function('modulePath', 'return import(modulePath);');
    wasmModulePromise = dynamicImport('/rust/boids-wasm/pkg/boids_wasm.js');
  }
  return wasmModulePromise;
}

/**
 * Mirrors the existing JS Flock API while sourcing boid updates from Rust/WASM.
 * Falls back at startup if the wasm bundle has not been generated yet.
 */
export class RustFlockAdapter {
  static async create(count, bounds, params) {
    const wasmModule = await loadWasmModule();
    let wasmExports = null;
    if (typeof wasmModule.default === 'function') {
      wasmExports = await wasmModule.default();
    }
    return new RustFlockAdapter(count, bounds, params, wasmModule, wasmExports);
  }

  constructor(count, bounds, params, wasmModule, wasmExports = null) {
    this.bounds = bounds;
    this.params = { ...params };
    this.wasm = wasmModule;
    this.wasmExports = wasmExports;
    this.sim = new this.wasm.FlockSim(count, bounds, this.#toSimParams(params));
    this.positionsView = null;
  }

  setCount(newCount) {
    this.sim.set_count(newCount);
    this.positionsView = null;
  }

  reset() {
    this.sim.reset();
  }

  update(params) {
    if (this.#didParamsChange(params)) {
      this.params = { ...params };
      this.sim.set_params(this.#toSimParams(params));
    }
    this.sim.update();
  }


  #getMemoryBuffer() {
    return (
      this.wasmExports?.memory?.buffer ||
      this.wasm?.memory?.buffer ||
      null
    );
  }

  getPositionsView() {
    const ptr = this.sim.positions_ptr();
    const len = this.sim.positions_len();
    const byteOffset = ptr;
    const memoryBuffer = this.#getMemoryBuffer();

    if (!memoryBuffer) {
      return this.sim.positions();
    }

    if (
      !this.positionsView ||
      this.positionsView.length !== len ||
      this.positionsView.byteOffset !== byteOffset ||
      this.positionsView.buffer !== memoryBuffer
    ) {
      this.positionsView = new Float32Array(memoryBuffer, byteOffset, len);
    }

    return this.positionsView;
  }

  // Compatibility path for call sites not yet switched to getPositionsView.
  getPositions() {
    return this.getPositionsView();
  }

  get count() {
    return this.sim.count();
  }

  isSimdEnabled() {
    return typeof this.sim.simd_enabled === "function" ? this.sim.simd_enabled() : false;
  }

  #didParamsChange(next) {
    return (
      next.visualRange !== this.params.visualRange ||
      next.protectedRange !== this.params.protectedRange ||
      next.centeringFactor !== this.params.centeringFactor ||
      next.avoidFactor !== this.params.avoidFactor ||
      next.matchingFactor !== this.params.matchingFactor ||
      next.maxSpeed !== this.params.maxSpeed ||
      next.minSpeed !== this.params.minSpeed ||
      next.turnFactor !== this.params.turnFactor ||
      next.margin !== this.params.margin
    );
  }

  #toSimParams(params) {
    return new this.wasm.SimParams(
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
