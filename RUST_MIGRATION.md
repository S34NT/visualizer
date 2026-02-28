# Rust/WASM migration starter

This repo includes a Rust simulation module scaffold at `rust/boids-wasm` and runtime wiring in `src/main.js`.

## What is implemented

- `SimParams`: Rust mirror of JS flocking parameters.
- `FlockSim`: Rust boid simulation with:
  - boid initialization/reset
  - O(n) spatial-grid neighborhood lookup
  - separation/alignment/cohesion
  - boundary turning + speed clamping
  - zero-copy positions export via `positions_ptr()` + `positions_len()`
- `RustFlockAdapter`: JS wrapper that:
  - initializes wasm on startup
  - passes params only when changed
  - exposes `getPositionsView()` backed directly by wasm memory

## Build commands

```bash
cargo install wasm-pack
wasm-pack build rust/boids-wasm --target web --out-dir pkg
```

This generates `rust/boids-wasm/pkg/boids_wasm.js` + `.wasm` artifacts.

## Runtime behavior

- `main.js` now attempts to start with Rust/WASM first.
- If `rust/boids-wasm/pkg` is missing, the app falls back to the original JS `Flock` and shows a status notice.
- `FlockRenderer` supports both backends and avoids per-frame array copies when using `getPositionsView()`.

## Benchmark toggle

- Press `B` in-app to toggle benchmark logging.
- Every ~120 frames, it logs:
  - backend (`rust` or `js`)
  - bird count
  - average simulation time
  - average frame time
  - approximate FPS

## Notes

- Initial wasm build is still a manual step.
- For best comparisons, benchmark with fixed bird counts and camera position across both backends.
