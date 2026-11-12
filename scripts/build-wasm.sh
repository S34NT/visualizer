#!/usr/bin/env bash
set -euo pipefail

if [[ "${SKIP_WASM_BUILD:-0}" == "1" ]]; then
  echo "[wasm] SKIP_WASM_BUILD=1 set, skipping Rust/WASM build"
  exit 0
fi

# Common install locations in CI environments (including Vercel)
export PATH="$HOME/.cargo/bin:/rust/bin:$PATH"

if ! command -v rustup >/dev/null 2>&1; then
  echo "[wasm] rustup not found; installing minimal Rust toolchain..."
  curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
  export PATH="$HOME/.cargo/bin:/rust/bin:$PATH"
  if [[ -f "$HOME/.cargo/env" ]]; then
    source "$HOME/.cargo/env"
  fi
fi

if ! rustup target list --installed | grep -q '^wasm32-unknown-unknown$'; then
  echo "[wasm] adding wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "[wasm] installing wasm-pack..."
  curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
  export PATH="$HOME/.cargo/bin:/rust/bin:$PATH"
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "[wasm] ERROR: wasm-pack installation completed but binary is not on PATH" >&2
  exit 1
fi

echo "[wasm] building rust/boids-wasm pkg (single-threaded, SIMD)..."
wasm-pack build rust/boids-wasm --target web --out-dir pkg

echo "[wasm] staging wasm artifacts into public/ for Vite+Vercel serving..."
mkdir -p public/rust/boids-wasm
rm -rf public/rust/boids-wasm/pkg
cp -R rust/boids-wasm/pkg public/rust/boids-wasm/

# ---------------------------------------------------------------------------
# Threaded variant (pkg-mt): rayon thread pool over the bird loop. Needs a
# nightly toolchain with rust-src so std can be rebuilt with atomics, and the
# page must be served with COOP/COEP headers (see vite.config.js / vercel.json).
# The app loads it only when `crossOriginIsolated` is true and falls back to
# pkg otherwise, so this step is best-effort.
# ---------------------------------------------------------------------------
if [[ "${SKIP_WASM_MT:-0}" == "1" ]]; then
  echo "[wasm] SKIP_WASM_MT=1 set, skipping threaded build"
  exit 0
fi

if ! rustup toolchain list | grep -q '^nightly'; then
  echo "[wasm] installing nightly toolchain for the threaded build..."
  rustup toolchain install nightly --profile minimal --component rust-src --target wasm32-unknown-unknown || true
fi
if ! rustup toolchain list | grep -q '^nightly'; then
  echo "[wasm] nightly unavailable; threaded build skipped (single-threaded pkg still works)"
  exit 0
fi
rustup +nightly component add rust-src >/dev/null 2>&1 || true
rustup +nightly target add wasm32-unknown-unknown >/dev/null 2>&1 || true

echo "[wasm] building rust/boids-wasm pkg-mt (threads + SIMD, nightly)..."
# This nightly no longer adds the shared-memory link args for +atomics itself,
# so they are passed explicitly (wasm-bindgen needs the TLS exports too).
set +e
RUSTUP_TOOLCHAIN=nightly \
RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals,+simd128 \
  -C link-arg=--shared-memory -C link-arg=--max-memory=1073741824 -C link-arg=--import-memory \
  -C link-arg=--export=__wasm_init_tls -C link-arg=--export=__tls_size \
  -C link-arg=--export=__tls_align -C link-arg=--export=__tls_base \
  -C link-arg=--export=__heap_base -C link-arg=--export=__data_end" \
CARGO_TARGET_DIR="$(pwd)/rust/boids-wasm/target-mt" \
wasm-pack build rust/boids-wasm --target web --out-dir pkg-mt \
  -- --features parallel -Z build-std=panic_abort,std
mt_status=$?
set -e
if [[ $mt_status -ne 0 ]]; then
  echo "[wasm] WARNING: threaded build failed (exit $mt_status); shipping single-threaded pkg only"
  rm -rf public/rust/boids-wasm/pkg-mt
  exit 0
fi
# The worker helper imports the package directory ('../../..'), which only a
# bundler resolves; we serve pkg-mt statically, so point it at the entry file.
sed -i "s#import('../../..')#import('../../../boids_wasm.js')#" rust/boids-wasm/pkg-mt/snippets/*/src/workerHelpers.js
rm -rf public/rust/boids-wasm/pkg-mt
cp -R rust/boids-wasm/pkg-mt public/rust/boids-wasm/
echo "[wasm] pkg and pkg-mt staged"
