import { defineConfig, loadEnv } from 'vite';
import glsl from 'vite-plugin-glsl';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [glsl()],
    // Default to root deployment (Vercel/Netlify). Override for subpath deploys with VITE_BASE_PATH.
    // Example for GitHub Pages: VITE_BASE_PATH=/murmurations/
    base: env.VITE_BASE_PATH || '/',
    server: {
      open: true
    },
    build: {
      outDir: 'dist',
      sourcemap: false
    }
  };
});
