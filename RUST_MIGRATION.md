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

## Neighbour search and throughput (performance pass)

- The `HashMap` cell grid was replaced by a flat counting-sort grid
  (`configure_grid`, `rebuild_spatial_grid`): `cell_start` / `cell_items`
  index birds by cell, z innermost so each (x, y) row of the 3×3×3 block is one
  contiguous slice.
- `set_max_neighbors(n)` / `max_neighbors()` cap the candidates evaluated per
  bird (default 64). Dense blocks are stride-sampled with a per-bird phase; the
  separation, rivalry and crowding sums are multiplied by the stride so their
  expected magnitude is unchanged. Cost is O(count × cap).
- `reorder_by_cell()` permutes every per-bird array into cell order every
  `reorder_interval` frames (default 8, `set_reorder_interval(0)` disables) so
  neighbour loads are cache-friendly. `best_parent` is invalidated and rebuilt
  the same step.
- `set_count()` now hatches new birds beside random existing ones (inheriting
  lineage), so Auto Quality growing the flock never scatters the shape.
- `.cargo/config.toml` enables `+simd128`; `Cargo.toml` uses opt-level 3 with
  one codegen unit. Browsers without WASM SIMD (Safari < 16.4) fall back to JS.
- Measured on one Haswell core in headless Chromium: ~1.4 µs per bird per step,
  linear to 64k birds (8k birds ≈ 12 ms; previously 2k birds ≈ 9 ms).

## Field buffer v3 (160 floats)

- `FIELD_SIZE` is 160 in both `FieldLayout.js` and `lib.rs`. New entries:
  `DRIFT_DAMPING` (75, applied in the sim loop after field forces),
  `CONTAIN_TYPE`/`CONTAIN_SCALE` (76..79: sphere, ellipsoid, rounded box),
  cymatic layers (`CYM_COUNT` 80, five layers of 12 floats from 81, affinity 141)
  and the shear counter-field (142..148). `apply_field` now also takes the
  bird's velocity (for the cymatic steering term) and lineage hue (band
  affinity). Keep `applyField` and `apply_field` index-for-index in sync.

## Threaded build (`parallel` feature, pkg-mt)

- The per-bird body lives in the free function `step_bird(&StepCtx, i) -> BirdOut`
  over a read-only `StepCtx` of slices (so it is `Sync`); `update()` fills
  `step_out` either sequentially or with `par_iter_mut()` under
  `#[cfg(feature = "parallel")]`, then `integrate_velocities_and_positions`
  applies velocities, energy and `best_parent`. Jitter uses a stateless hash
  (`hash_random(seed, i, lane)`) instead of the shared xorshift RNG.
- `scripts/build-wasm.sh` builds `pkg` (stable, single-threaded) and then, best
  effort, `pkg-mt` with nightly: `-Z build-std=panic_abort,std`, target
  features `+atomics,+bulk-memory,+mutable-globals,+simd128`, and explicit
  linker args `--shared-memory --import-memory --max-memory=1GiB` plus the
  `__wasm_init_tls/__tls_*`/`__heap_base`/`__data_end` exports that
  wasm-bindgen's threading transform requires (this nightly does not add them
  for `+atomics` on its own). The generated `workerHelpers.js` is patched to
  import `../../../boids_wasm.js` because it is served statically, not bundled.
  `SKIP_WASM_MT=1` skips the threaded build; a failed threaded build never fails
  `npm run build`.
- `RustFlockAdapter.create()` tries `pkg-mt` only when `crossOriginIsolated`
  is true, with a 6 s timeout on `initThreadPool`, and falls back to `pkg`.
  Because WebGL rejects views over `SharedArrayBuffer`, the adapter copies
  positions/velocities/genomes into ordinary `Float32Array`s each frame when
  the memory is shared. `thread_count()` / `threads_enabled()` report the pool.
- Measured on this 12-core box with 8 workers: 32k birds ≈ 10 ms, 64k ≈ 20 ms
  per step (single-threaded: 49 ms / 105 ms). Small flocks gain less because the
  grid rebuild, integration and reproduction passes are still sequential.

## SIMD integration

- `FlockSim` now includes a SIMD-enabled integration path for velocity/position application when compiled for `wasm32` with `simd128`.
- A scalar fallback path is retained for compatibility.
- Runtime benchmark logs now include `variant` (`rust-simd`, `rust-scalar`, or `js`) to simplify A/B testing.


## Force fields and velocities (choreographer support)

- `FlockSim::set_field(&[f32])` copies the 64-float force-field buffer defined in
  `src/fields/FieldLayout.js`. `apply_field` in `lib.rs` mirrors the JS
  `applyField` index-for-index (curl-noise wind, vortex, shape attractors,
  agents, pulse, wind, containment, personality spread). Keep both in sync.
- `velocities_ptr()` / `velocities_len()` expose a velocity buffer next to the
  positions so the renderer can colour by heading and speed.
- Each bird carries a `trait` (0.7..1.3) that scales its speed envelope and
  field susceptibility; jitter uses an internal xorshift PRNG rather than
  calling into JS per bird.
- `RustFlockAdapter` detects a stale `pkg` (no `set_field`) and logs a warning;
  rebuild with `npm run build:wasm` after changing `lib.rs`.
- Evolution layer: `hue`, `energy`, `cohesion_gene` per bird; the neighbour loop
  weights alignment / cohesion by kinship (field index 65), applies cross-lineage
  repulsion (66), and updates energy (69/70/71/73). `reproduce()` runs a sliding
  window of death / division each frame (67/68/72/74). `genomes_ptr()` exposes
  `[hue, energy]` per bird; `species_count()`, `dominant_share()` and `births()`
  feed the GUI readouts. Again, keep `Flock.js` / `Boid.js` in sync.
