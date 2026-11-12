const dynamicImport = new Function('modulePath', 'return import(modulePath);');

let wasmModulePromise = null;

async function loadWasmModule() {
  if (!wasmModulePromise) {
    wasmModulePromise = dynamicImport('/rust/boids-wasm/pkg/boids_wasm.js');
  }
  return wasmModulePromise;
}

/** Threads need SharedArrayBuffer, which browsers only expose on cross-origin isolated pages. */
export function canUseThreads() {
  return (
    typeof crossOriginIsolated !== 'undefined' &&
    crossOriginIsolated === true &&
    typeof SharedArrayBuffer !== 'undefined' &&
    typeof Worker !== 'undefined'
  );
}

/** Leave a core for the main thread / renderer; cap so phones don't spin all little cores. */
export function defaultThreadCount() {
  const hw = navigator.hardwareConcurrency || 4;
  return Math.max(1, Math.min(8, hw - 1));
}

/**
 * Mirrors the existing JS Flock API while sourcing boid updates from Rust/WASM.
 * Falls back at startup if the wasm bundle has not been generated yet.
 */
export class RustFlockAdapter {
  static async create(count, bounds, params, options = {}) {
    const wantThreads = options.threads !== false && canUseThreads();
    if (wantThreads) {
      try {
        const mt = await dynamicImport('/rust/boids-wasm/pkg-mt/boids_wasm.js');
        const exports = await mt.default();
        const threads = options.threadCount || defaultThreadCount();
        // A pool that never comes up (blocked worker, missing file) must not
        // hang the app: give it a few seconds, then use the single-threaded core.
        await Promise.race([
          mt.initThreadPool(threads),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('thread pool init timed out')), 6000)
          )
        ]);
        const adapter = new RustFlockAdapter(count, bounds, params, mt, exports);
        adapter.threads = typeof adapter.sim.thread_count === 'function' ? adapter.sim.thread_count() : threads;
        return adapter;
      } catch (error) {
        console.warn('Threaded WASM core unavailable, using the single-threaded core:', error);
      }
    }

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
    this.velocitiesView = null;
    this.genomesView = null;
    this.supportsField = typeof this.sim.set_field === 'function';
    this.supportsVelocities = typeof this.sim.velocities_ptr === 'function';
    this.supportsGenomes = typeof this.sim.genomes_ptr === 'function';
    this.field = null;
    this.threads = 1;
    // WebGL refuses views over SharedArrayBuffer, so the threaded core's
    // buffers are copied into ordinary Float32Arrays before upload.
    const buffer = this.#getMemoryBuffer();
    this.sharedMemory = typeof SharedArrayBuffer !== 'undefined' && buffer instanceof SharedArrayBuffer;
    this.copies = { positions: null, velocities: null, genomes: null };
  }

  isThreaded() {
    return this.threads > 1;
  }

  setCount(newCount) {
    this.sim.set_count(newCount);
    this.positionsView = null;
    this.velocitiesView = null;
    this.genomesView = null;
  }

  reset() {
    this.sim.reset();
  }

  /** Accepts the shared Float32Array described in FieldLayout.js. */
  setField(fieldBuffer) {
    this.field = fieldBuffer;
  }

  setMaxNeighbors(n) {
    if (typeof this.sim.set_max_neighbors === 'function') this.sim.set_max_neighbors(n);
  }

  maxNeighbors() {
    return typeof this.sim.max_neighbors === 'function' ? this.sim.max_neighbors() : 0;
  }

  update(params) {
    if (this.#didParamsChange(params)) {
      this.params = { ...params };
      this.sim.set_params(this.#toSimParams(params));
    }
    if (this.field && this.supportsField) {
      this.sim.set_field(this.field);
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

  #view(current, ptr, len, fallback, copyKey = null) {
    const memoryBuffer = this.#getMemoryBuffer();
    if (!memoryBuffer) return { view: fallback(), cached: null };

    if (
      !current ||
      current.length !== len ||
      current.byteOffset !== ptr ||
      current.buffer !== memoryBuffer
    ) {
      current = new Float32Array(memoryBuffer, ptr, len);
    }
    if (this.sharedMemory && copyKey) {
      let copy = this.copies[copyKey];
      if (!copy || copy.length !== len) {
        copy = new Float32Array(len);
        this.copies[copyKey] = copy;
      }
      copy.set(current);
      return { view: copy, cached: current };
    }
    return { view: current, cached: current };
  }

  getPositionsView() {
    const { view, cached } = this.#view(
      this.positionsView,
      this.sim.positions_ptr(),
      this.sim.positions_len(),
      () => this.sim.positions(),
      'positions'
    );
    this.positionsView = cached;
    return view;
  }

  getVelocitiesView() {
    if (!this.supportsVelocities) return null;
    const { view, cached } = this.#view(
      this.velocitiesView,
      this.sim.velocities_ptr(),
      this.sim.velocities_len(),
      () => this.sim.velocities(),
      'velocities'
    );
    this.velocitiesView = cached;
    return view;
  }

  getGenomesView() {
    if (!this.supportsGenomes) return null;
    const { view, cached } = this.#view(
      this.genomesView,
      this.sim.genomes_ptr(),
      this.sim.genomes_len(),
      () => this.sim.genomes(),
      'genomes'
    );
    this.genomesView = cached;
    return view;
  }

  getGenomes() {
    return this.getGenomesView();
  }

  speciesCount() {
    return this.supportsGenomes ? this.sim.species_count() : 0;
  }

  dominantShare() {
    return this.supportsGenomes ? this.sim.dominant_share() : 0;
  }

  // Compatibility path for call sites not yet switched to getPositionsView.
  getPositions() {
    return this.getPositionsView();
  }

  getVelocities() {
    return this.getVelocitiesView();
  }

  get count() {
    return this.sim.count();
  }

  isSimdEnabled() {
    return typeof this.sim.simd_enabled === 'function' ? this.sim.simd_enabled() : false;
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
