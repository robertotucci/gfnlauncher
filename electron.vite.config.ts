import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      // Sandboxed preload scripts cannot be ES modules, and we want to keep
      // sandbox: true. Force CommonJS output regardless of package.json type.
      rollupOptions: {
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs'
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()],
    build: {
      // electron-vite leaves minification off by default; a launcher that has to
      // paint fast at session start should not parse unminified source.
      minify: 'esbuild',
      rollupOptions: {
        input: resolve('src/renderer/index.html')
      }
    }
  }
})
