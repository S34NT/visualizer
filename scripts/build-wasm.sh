#!/usr/bin/env bash
set -euo pipefail

if [[ "${SKIP_WASM_BUILD:-0}" == "1" ]]; then
  echo "[wasm] SKIP_WASM_BUILD=1 set, skipping Rust/WASM build"
  exit 0
fi

if ! command -v rustup >/dev/null 2>&1; then
  echo "[wasm] rustup not found; installing minimal Rust toolchain..."
  curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
  source "$HOME/.cargo/env"
fi

if ! rustup target list --installed | rg -q '^wasm32-unknown-unknown$'; then
  echo "[wasm] adding wasm32-unknown-unknown target..."
  rustup target add wasm32-unknown-unknown
fi

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "[wasm] installing wasm-pack..."
  curl https://rustwasm.github.io/wasm-pack/installer/init.sh -sSf | sh
fi

echo "[wasm] building rust/boids-wasm pkg..."
wasm-pack build rust/boids-wasm --target web --out-dir pkg

echo "[wasm] staging wasm artifacts into public/ for Vite+Vercel serving..."
mkdir -p public/rust/boids-wasm
rm -rf public/rust/boids-wasm/pkg
cp -R rust/boids-wasm/pkg public/rust/boids-wasm/
