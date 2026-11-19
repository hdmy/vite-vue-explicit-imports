import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts', 'src/vite.ts', 'src/cli.ts'],
  format: 'esm',
  fixedExtension: true,
  dts: true,
})
