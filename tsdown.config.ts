import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['bin/uni-hmr.ts'],
  outDir: 'dist',
  format: 'esm',
  platform: 'node',
  target: 'node22',
  clean: true,
  dts: false,
  sourcemap: true,
})
