import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

export default tseslint.config(
  {
    ignores: [
      'out/**',
      'release/**',
      'node_modules/**',
      'src/renderer/src/components/ui/**',
      // Flatpak build output. `build-dir` holds a whole unpacked Electron —
      // four thousand lint errors' worth of somebody else's minified JavaScript.
      'build-dir/**',
      'repo/**',
      '.flatpak-builder/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.node, ...globals.browser }
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  {
    // The packaging scripts, which are Node ESM rather than TypeScript. The
    // block above names only .ts and .tsx, so without this they are linted with
    // no globals at all and every `process` and `console` is an undefined
    // variable.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node }
    }
  }
)
