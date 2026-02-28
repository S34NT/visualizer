# Rust/WASM migration starter

This repo now includes a Rust simulation module scaffold at `rust/boids-wasm`.

## What is implemented

- `SimParams`: Rust mirror of JS flocking parameters.
- `FlockSim`: Rust boid simulation with:
  - boid initialization/reset
  - O(n) spatial-grid neighborhood lookup
  - separation/alignment/cohesion
  - boundary turning + speed clamping
  - flat `positions()` export for Three.js buffer updates

## Build commands

```bash
cargo install wasm-pack
wasm-pack build rust/boids-wasm --target web --out-dir pkg
```

This generates `rust/boids-wasm/pkg/boids_wasm.js` + `.wasm` artifacts.

## JS integration path

A compatibility wrapper exists at `src/boids/RustFlockAdapter.js`.

To switch runtime simulation from JS to Rust in `main.js`:

1. Replace `Flock` import with `RustFlockAdapter`.
2. Make startup async (or init before simulator constructor).
3. Instantiate with `await RustFlockAdapter.create(...)`.
4. Keep `FlockRenderer` unchanged: it still consumes `getPositions()` output.

## Notes

- The first iteration returns a copied positions array from WASM each frame for simplicity.
- If needed, optimize later by exposing raw WASM memory views to avoid copies.
