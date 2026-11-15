/** Build only this external package with the checkout's installed official bundler. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(new URL('../../package.json', import.meta.url))
const bin = require.resolve('tsdown/run')
const result = spawnSync(process.execPath, [bin, '--config', 'tsdown.config.ts'], { cwd: root, stdio: 'inherit' })
process.exitCode = result.status ?? 1
