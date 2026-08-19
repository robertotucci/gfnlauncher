import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Fails the build if a preload is split across more than one file.
 *
 * **A sandboxed preload cannot `require` a relative path.** Electron gives it a
 * polyfill that resolves `electron`, `events`, `timers` and `url` and throws
 * `module not found` on anything else. So the moment two preload entries import
 * the same module, Rollup hoists it into a shared chunk, both entries require
 * it, and *both* preloads die at load — the bridge included, which is every
 * control in the launcher.
 *
 * That failure is silent at build time and total at run time, and it is one
 * shared import away at all times. Rollup has no option that duplicates shared
 * code back into its entries (`experimentalMinChunkSize` does not: it will not
 * duplicate across entries), so the rule is kept by hand and enforced here.
 *
 * If this ever fires: give the offending entry its own copy. `src/preload/
 * pointer.ts` shows the shape — a type-only import of `IPC` and two literals
 * the compiler checks against it, so nothing is shared at runtime and a renamed
 * channel is still a compile error.
 */
function oneFilePerPreload(): Plugin {
  return {
    name: 'gfn-one-file-per-preload',
    generateBundle(_options, bundle) {
      const split = Object.values(bundle).filter(
        (output) => output.type === 'chunk' && !output.isEntry
      )
      if (split.length === 0) return

      this.error(
        'A preload was split into shared chunks, which cannot be loaded in a ' +
          'sandboxed preload: ' +
          split.map((chunk) => chunk.fileName).join(', ') +
          '. Each entry in src/preload/ must bundle to exactly one file — see ' +
          'the note on this plugin in electron.vite.config.ts.'
      )
    }
  }
}

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
    plugins: [externalizeDepsPlugin(), oneFilePerPreload()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      // Sandboxed preload scripts cannot be ES modules, and we want to keep
      // sandbox: true. Force CommonJS output regardless of package.json type.
      rollupOptions: {
        // Two preloads, and they are opposites. `index` is the bridge the
        // launcher's own UI talks through; `pointer` goes on the two windows
        // that render somebody else's page and deliberately exposes *nothing* —
        // see the header of src/preload/pointer.ts. Naming both here is what
        // stops electron-vite falling back to its single-entry default and
        // silently dropping the second one.
        input: {
          index: resolve('src/preload/index.ts'),
          pointer: resolve('src/preload/pointer.ts')
        },
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
