import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';

export default defineConfig({
  plugins: [glsl()],
  // Base path for GitHub Pages (repo name)
  base: '/murmurations/',
  server: {
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
});

