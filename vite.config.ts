import { defineConfig } from 'vitest/config';
import { viteSingleFile } from 'vite-plugin-singlefile';

// `npm run build`        -> dist/ (static files, host anywhere)
// `npm run build:single` -> dist-single/index.html (one self-contained file you can send to a friend)
export default defineConfig(({ mode }) => ({
  base: './',
  plugins: mode === 'single' ? [viteSingleFile()] : [],
  build: {
    chunkSizeWarningLimit: 900,
    outDir: mode === 'single' ? 'dist-single' : 'dist',
  },
  test: { include: ['tests/**/*.test.ts'] },
}));
