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

## Vercel setup (auto-build wasm)

This repo includes:

- `scripts/build-wasm.sh`: installs required Rust/wasm tooling (if missing), builds `rust/boids-wasm/pkg`, then copies it to `public/rust/boids-wasm/pkg`
- `vercel.json`: sets `buildCommand` to `npm run vercel-build`

So a standard Vercel deploy now runs wasm generation automatically as part of build.

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

- `npm run build` now triggers wasm generation automatically via `scripts/build-wasm.sh`.
- For best comparisons, benchmark with fixed bird counts and camera position across both backends.
