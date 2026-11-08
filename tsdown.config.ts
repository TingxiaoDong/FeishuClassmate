import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/runtime/cli-main.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist',
  dts: true,
  clean: true,
});
