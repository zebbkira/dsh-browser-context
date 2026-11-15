/** Inspect the published payload and validate package-local compiler output; never build core packages. */
import assert from 'node:assert/strict'
import { readFile, access } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
const root = new URL('..', import.meta.url)
const manifest = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))
for (const path of [manifest.main, manifest.exports['./client'], manifest.dsh.bundle.patch, 'README.md']) await access(new URL(path, root))
const host = await import(new URL(manifest.main, root))
assert.equal(host.name, manifest.name)
assert.equal(typeof host.apply, 'function')
assert.equal(typeof host.Config['~standard'].validate, 'function')
const validation = host.Config['~standard'].validate({ maxTextBytes: 65536, maxImageBytes: 10485760 })
assert.equal(validation.issues, undefined)
host.apply({}, validation.value)
for (const value of [0, -1, 1.5, Infinity]) assert.ok(host.Config['~standard'].validate({ maxTextBytes: value, maxImageBytes: 1 }).issues)
const code = await readFile(new URL(manifest.exports['./client'], root), 'utf8')
let registration
vm.runInNewContext(code, { window: { __ModuleLoader__: { load(row) { registration = row } } } })
assert.equal(registration.id, manifest.name)
assert.equal(typeof registration.factory, 'function')
assert.equal(/require\(['"]@deepseek-ai\/dsh-client-ui-(?:conversation|sidebar-browser)(?:\/client)?['"]\)/u.test(code), false)
const require = createRequire(new URL('../../package.json', import.meta.url))
const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', fileURLToPath(new URL('tsconfig.json', root)), '--noEmit'], { stdio: 'inherit' })
assert.equal(result.status, 0, 'package-local noEmit typecheck failed')
console.log('Published Host Config, self-contained entry, client module registration, feature-import isolation, and noEmit typecheck passed')
