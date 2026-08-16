import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@': resolve('src/renderer/src'),
      '@main': resolve('src/main'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx']
  }
})
