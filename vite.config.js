import { defineConfig, loadEnv } from 'vite';
import glsl from 'vite-plugin-glsl';

const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp'
};

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [glsl()],
    // Default to root deployment (Vercel/Netlify). Override for subpath deploys with VITE_BASE_PATH.
    // Example for GitHub Pages: VITE_BASE_PATH=/murmurations/
    base: env.VITE_BASE_PATH || '/',
    // Cross-origin isolation lets the threaded WASM core (SharedArrayBuffer +
    // Web Workers) load. Without these headers the app silently uses the
    // single-threaded core.
    server: {
      open: true,
      headers: isolationHeaders
    },
    preview: {
      headers: isolationHeaders
    },
    build: {
      outDir: 'dist',
      sourcemap: false
    }
  };
});
