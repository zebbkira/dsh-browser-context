/** Package-local tests use source imports and no live browser or network. */
import { defineConfig } from 'vitest/config'
import tsconfigPaths from 'vite-tsconfig-paths'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { dirname } from 'node:path'
const require = createRequire(new URL('../packages/client/ui-primitives/package.json', import.meta.url))
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  resolve: { alias: [
    { find: /^react(\/.*)?$/, replacement: `${dirname(require.resolve('react/package.json')).replaceAll('\\', '/')}$1` },
    { find: /^react-dom(\/.*)?$/, replacement: `${dirname(require.resolve('react-dom/package.json')).replaceAll('\\', '/')}$1` },
  ] },
  plugins: [tsconfigPaths({ projects: [fileURLToPath(new URL('../tsconfig.base.json', import.meta.url))] })],
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'], environment: 'jsdom', maxWorkers: 1 },
})
