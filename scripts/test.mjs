/** Run only this package's deterministic mock and component tests. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
const require = createRequire(new URL('../../package.json', import.meta.url))
const bin = join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs')
const result = spawnSync(process.execPath, [bin, 'run', '--config', 'dsh-browser-context/vitest.config.ts'], {
  cwd: new URL('../..', import.meta.url), stdio: 'inherit',
})
process.exitCode = result.status ?? 1
