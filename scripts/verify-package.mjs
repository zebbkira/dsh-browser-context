#!/usr/bin/env node
/** Packed-module smoke only: imports the Host and captures client registration, never launches DSH. */
import assert from 'node:assert/strict';
import { readFile, lstat, realpath, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));

/** Only literal module specifiers are relevant; sourcemap source paths are not runtime imports. */
function moduleSpecifiers(source) {
  const patterns = [
    /\b(?:require|import)\s*\(\s*(['"])([^'"\r\n]+)\1\s*\)/g,
    /\b(?:import|export)\s+(?:[^;\n]*?\s+from\s*)?(['"])([^'"\r\n]+)\1/g,
  ];
  return patterns.flatMap((pattern) => Array.from(source.matchAll(pattern), (match) => match[2]));
}

async function checkNoModules(root) {
  // An isolated TemporaryDirectory has no checkout ancestors. Check every
  // ancestor too, because Node's ESM resolver walks upward for bare packages.
  for (let current = root; ; current = path.dirname(current)) {
    let exists = true;
    try {
      await access(path.join(current, 'node_modules'), constants.F_OK);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      exists = false;
    }
    assert.equal(exists, false, 'isolated-import-ancestor-has-node-modules');
    if (path.dirname(current) === current) break;
  }
  assert.equal(process.env.NODE_PATH, undefined, 'NODE_PATH-must-be-unset');
  assert.equal(process.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS-must-be-unset');
}

async function internalFile(root, relative) {
  const target = await realpath(path.resolve(root, relative));
  const within = path.relative(root, target);
  assert.ok(within && !within.startsWith('..') && !path.isAbsolute(within), 'module-outside-package');
  const info = await lstat(target);
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'module-not-regular-file');
  return target;
}

async function checkHostImports(root, entry, visited = new Set()) {
  if (visited.has(entry)) return;
  visited.add(entry);
  const source = await readFile(entry, 'utf8');
  for (const specifier of moduleSpecifiers(source)) {
    assert.ok(!/^(?:[a-z]:[\\/]|file:|[\\/])/i.test(specifier), 'absolute-host-runtime-import');
    if (builtins.has(specifier)) continue;
    assert.ok(specifier.startsWith('./') || specifier.startsWith('../'), 'external-host-runtime-import');
    const target = await internalFile(root, path.relative(root, path.resolve(path.dirname(entry), specifier)));
    if (/\.[cm]?js$/.test(target)) await checkHostImports(root, target, visited);
  }
}

async function smoke(rootArgument) {
  assert.equal(typeof rootArgument, 'string', 'package-directory-required');
  const root = await realpath(rootArgument);
  await checkNoModules(root);
  const entry = await internalFile(root, './lib/index.js');
  await checkHostImports(root, entry);
  const host = await import(pathToFileURL(entry).href);
  assert.equal(host.name, 'dsh-browser-context');
  assert.equal(typeof host.apply, 'function');
  const standard = host.Config?.['~standard'];
  assert.equal(standard?.version, 1);
  assert.equal(typeof standard.vendor, 'string');
  assert.equal(typeof standard.validate, 'function');
  const limits = { maxTextBytes: 65536, maxImageBytes: 10485760, subtitleRequestTimeoutMs: 15000 };
  const valid = await standard.validate(limits);
  assert.equal(valid.issues, undefined, 'valid-limits-rejected');
  assert.ok(valid.value, 'validated-value-missing');
  for (const [field, expected] of Object.entries(limits)) {
    const actual = valid.value[field];
    assert.equal(typeof actual?.get === 'function' ? actual.get() : actual, expected);
    const invalid = await standard.validate({ ...limits, [field]: 0 });
    assert.ok(Array.isArray(invalid.issues) && invalid.issues.length > 0, 'zero-limit-accepted');
  }
  const defaulted = await standard.validate({ maxTextBytes: 65536, maxImageBytes: 10485760 });
  assert.equal(defaulted.issues, undefined, 'timeout-default-rejected');
  const timeout = defaulted.value?.subtitleRequestTimeoutMs;
  assert.equal(typeof timeout?.get === 'function' ? timeout.get() : timeout, 15000, 'timeout-default-missing');
  const overflow = await standard.validate({ ...limits, subtitleRequestTimeoutMs: 2147483648 });
  assert.ok(Array.isArray(overflow.issues) && overflow.issues.length > 0, 'timeout-overflow-accepted');
  // No App/context/SDK is constructed. Host apply only gets the already parsed limits.
  host.apply(Object.freeze({}), valid.value);
  console.log('PASS Host: independent ESM import without node_modules/SDK; name/apply/StandardSchema; three limits, zero rejections, timeout default and upper bound');

  const client = await readFile(await internalFile(root, './lib/client.js'), 'utf8');
  for (const specifier of moduleSpecifiers(client)) {
    assert.ok(!/(?:ui-sidebar-browser|ui-conversation)(?:$|\/)/.test(specifier), 'client-runtime-feature-plugin-import');
    assert.ok(!/^(?:[a-z]:[\\/]|file:|[\\/])/i.test(specifier), 'absolute-client-runtime-import');
    assert.ok(!/(?:deepseek-harness|packages[\\/]client|featurePlugins[\\/])/i.test(specifier), 'checkout-client-runtime-import');
  }
  // Source map paths are metadata, not runtime imports. Non-map checkout paths
  // elsewhere in the JS (including captured strings) are still rejected.
  const runtimeText = client.replace(/^\s*\/\/[@#]\s*sourceMappingURL=.*$/gm, '');
  assert.ok(!/(?:[a-z]:[\\/](?:[^\s'"`]*[\\/])?(?:deepseek-harness|packages)[\\/]|file:\/\/\/[^\s'"`]*deepseek-harness)/i.test(runtimeText), 'checkout-filepath-in-client');
  const registrations = [];
  const context = vm.createContext({
    window: Object.freeze({ __ModuleLoader__: Object.freeze({ load(registration) { registrations.push(registration); } }) }),
  }, { codeGeneration: { strings: false, wasm: false } });
  new vm.Script(client, { filename: 'packed-client.js' }).runInContext(context, { timeout: 5000 });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, 'dsh-browser-context');
  assert.equal(typeof registrations[0].factory, 'function');
  // The factory remains uncalled: no real client dependencies, DOM, model, network or App.
  console.log('PASS client: VM captured one __ModuleLoader__ registration id=dsh-browser-context and callable factory (not invoked)');
  console.log('SCOPE: payload/Host/module-registration smoke only; not a clean-profile install or real-page test');
}

try {
  await smoke(process.argv[2]);
} catch (error) {
  // Do not emit stack traces, absolute temporary paths or source payloads.
  const message = error instanceof assert.AssertionError && /^[a-z][a-z0-9-]+$/.test(error.message)
    ? error.message : 'module-smoke-exception';
  console.error(`FAIL packed module smoke: ${message}`);
  process.exitCode = 1;
}
