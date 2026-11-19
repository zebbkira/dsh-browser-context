/** All file contents are synthetic; the injected reader never touches a filesystem or network. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { prepareLocalHtml } from '../src/readers/local-html.ts'
import type { LocalHtmlRead } from '../src/readers/local-html.ts'
import { LocalHtmlError } from '../src/browser/local-html-types.ts'
import type { LocalHtmlBundle, LocalHtmlLimits } from '../src/browser/local-html-types.ts'
import { parseFileAddress } from '../../packages/util/workspace-path/src/file-address.ts'

const session = 's /中文' as SessionId
const root = '/work/demo/index.html'
const limits: LocalHtmlLimits = { maxBytes: 100_000, maxFiles: 20, timeoutMs: 30_000 }
const encode = (value: string): Uint8Array => new TextEncoder().encode(value)
function file(text: string | Uint8Array, absolutePath = root, extra: Partial<WorkspaceFileBytes> = {}): WorkspaceFileBytes {
  const data = typeof text === 'string' ? encode(text) : text
  return { absolutePath, version: 'v1', data, bytes: data.byteLength, offset: 0, eof: true, ...extra }
}
function fixture(html: string | Uint8Array, assets: Record<string, string | Uint8Array> = {}) {
  const read = vi.fn<LocalHtmlRead>(async (path) => ({ ok: true, value: path === root ? file(html) : file(assets[path] ?? '', `/work/demo/${path.replace(/^\.\//u, '')}`) }))
  return { read, run: (override: Partial<LocalHtmlLimits> = {}, signal = new AbortController().signal) => prepareLocalHtml(session, root, read, { ...limits, ...override }, signal) }
}
function size(bundle: LocalHtmlBundle): number {
  return encode(JSON.stringify({ ...bundle, assets: bundle.assets.map(asset => ({ ...asset, bytes: Buffer.from(asset.bytes).toString('base64') })) })).byteLength
}
async function code(result: Promise<unknown>, expected: string): Promise<void> {
  await expect(result).rejects.toMatchObject({ name: 'LocalHtmlError', code: expected, message: `Local HTML: ${expected}` })
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('prepareLocalHtml complete static snapshot', () => {
  it('reads direct assets sequentially with canonical baseFile, original references and stripped URL suffixes', async () => {
    const html = '<title>示例 &amp; title</title><script src="./scripts/a%20b.js?v=1&amp;x=2#here"></script><link rel="alternate stylesheet" href="style.css?q"><img src="images/a.PNG#view"><script>window.demo = 1</script>'
    const f = fixture(html, { './scripts/a b.js': 'window.ok=1', 'style.css': 'body { color: red }', 'images/a.PNG': new Uint8Array([0, 255]) })
    const bundle = await f.run()
    expect(bundle.title).toBe('示例 & title')
    expect(bundle.html).toBe(html)
    expect(bundle.assets.map(asset => [asset.reference, asset.kind, asset.mimeType])).toEqual([
      ['./scripts/a%20b.js?v=1&x=2#here', 'script', 'text/javascript'], ['style.css?q', 'stylesheet', 'text/css'], ['images/a.PNG#view', 'image', 'image/png'],
    ])
    expect(f.read.mock.calls.map(([path, options]) => [path, options])).toEqual([
      [root, {}], ['./scripts/a b.js', { baseFile: root }], ['style.css', { baseFile: root }], ['images/a.PNG', { baseFile: root }],
    ])
    expect(bundle.source).toEqual({ path: root, version: 'v1', resourceAddress: 'dsh-resource://file/session/s%20%2F%E4%B8%AD%E6%96%87//work/demo/index.html' })
    expect(parseFileAddress(bundle.source.resourceAddress)).toEqual({ scope: 'session', sessionId: session, path: root })
  })

  it.each(['/real/a b#?%.html', 'C:\\real\\中文 #?%.HTM', '\\\\server\\share\\a.html'])('uses root read identity, not caller spelling: %s', async path => {
    const read = vi.fn<LocalHtmlRead>(async () => ({ ok: true, value: file('<p>ok</p>', path, { version: 'opaque/2' }) }))
    const bundle = await prepareLocalHtml(session, 'captured.html', read, limits, new AbortController().signal)
    expect(read.mock.calls[0]?.slice(0, 2)).toEqual(['captured.html', {}])
    expect(bundle.source.path).toBe(path)
    expect(bundle.source.version).toBe('opaque/2')
    expect(parseFileAddress(bundle.source.resourceAddress)).toEqual({ scope: 'session', sessionId: session, path: path.replaceAll('\\', '/') })
    expect(bundle.title).toBe(path.replaceAll('\\', '/').split('/').at(-1))
  })

  it('keeps inline HTML and HTTP/data/blob resources inert, without fetching or executing them', async () => {
    const fetch = vi.fn(() => { throw new Error('unexpected network') })
    vi.stubGlobal('fetch', fetch)
    const append = vi.spyOn(document.body, 'appendChild')
    const f = fixture('<title>CDN</title><style>body{background:url(https://cdn.test/bg.png)}</style><script src="https://cdn.test/a.js"></script><link rel="stylesheet" href="https://cdn.test/a.css"><img src="data:image/png;base64,AA=="><img src="blob:https://example.test/id"><script>window.__localExecuted = true</script>')
    const bundle = await f.run()
    expect(bundle.assets).toEqual([])
    expect(f.read).toHaveBeenCalledTimes(1)
    expect(fetch).not.toHaveBeenCalled()
    expect(append).not.toHaveBeenCalled()
    expect(Reflect.get(window, '__localExecuted')).toBeUndefined()
  })

  it('waits for each asset before issuing the next authorized read', async () => {
    const f = fixture('<img src="a.png"><img src="b.png">')
    let started!: () => void
    const reading = new Promise<void>(resolve => { started = resolve })
    let finish!: (value: Awaited<ReturnType<LocalHtmlRead>>) => void
    f.read.mockResolvedValueOnce({ ok: true, value: file('<img src="a.png"><img src="b.png">') })
      .mockImplementationOnce(() => { started(); return new Promise(resolve => { finish = resolve }) })
    const pending = f.run()
    await reading
    expect(f.read.mock.calls.map(([path]) => path)).toEqual([root, 'a.png'])
    finish({ ok: true, value: file('x', '/work/demo/a.png') })
    expect((await pending).assets).toHaveLength(2)
    expect(f.read.mock.calls.map(([path]) => path)).toEqual([root, 'a.png', 'b.png'])
  })

  it('deduplicates identical references without collapsing distinct query references', async () => {
    const f = fixture('<img src="a.png"><img src="a.png"><img src="a.png?v2">', { 'a.png': 'x' })
    expect((await f.run({ maxFiles: 2 })).assets).toHaveLength(2)
    expect(f.read).toHaveBeenCalledTimes(3)
  })

  it.each(['svg', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'ico', 'avif', 'bmp'])('supports direct %s images', async ext => {
    const bundle = await fixture(`<img src="a.${ext}">`, { [`a.${ext}`]: 'image fixture' }).run()
    expect(bundle.assets[0]?.mimeType).toMatch(/^image\//u)
  })
})

describe('bounded complete results', () => {
  it('accepts the exact base64-serialized multibyte bundle size and refuses one byte less', async () => {
    const f = fixture('<title>中文🙂</title><img src="a.png">', { 'a.png': new Uint8Array([0, 1, 2, 3]) })
    const bundle = await f.run()
    const bytes = size(bundle)
    expect(size(await f.run({ maxBytes: bytes }))).toBe(bytes)
    await code(f.run({ maxBytes: bytes - 1 }), 'limit')
  })
  it('includes source/title/wrappers even when raw HTML fits', async () => {
    const f = fixture('<p>x</p>')
    await code(f.run({ maxBytes: encode('<p>x</p>').length }), 'limit')
    await code(f.run({ maxBytes: 1 }), 'limit')
  })
  it('rejects an oversized single asset, and counts combined raw bytes', async () => {
    const f = fixture('<img src="a.png">', { 'a.png': new Uint8Array(2_000) })
    await code(f.run({ maxBytes: 1_000 }), 'limit')
    const g = fixture('<img src="a.png"><img src="b.png">', { 'a.png': new Uint8Array(600), 'b.png': new Uint8Array(600) })
    await code(g.run({ maxBytes: 1_000 }), 'limit')
  })
  it('prechecks all dependency counts before reading any asset', async () => {
    const f = fixture(Array.from({ length: 30 }, (_, i) => `<img src="${i}.png">`).join(''))
    await code(f.run({ maxFiles: 29 }), 'limit')
    expect(f.read).toHaveBeenCalledTimes(1)
    expect((await fixture('single file').run({ maxFiles: 0 })).assets).toEqual([])
  })
  it.each([{ maxBytes: 0 }, { maxBytes: Infinity }, { maxFiles: -1 }, { maxFiles: 1.1 }, { timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }])('rejects invalid configuration %j', async override => {
    const f = fixture('ok')
    await code(f.run(override), 'config')
    expect(f.read).not.toHaveBeenCalled()
  })
})

describe('Host authorization and file integrity', () => {
  it('sanitizes Host denied and thrown failures without retry or content leakage', async () => {
    const f = fixture('x')
    f.read.mockRejectedValueOnce(new Error('token=secret document contents'))
    await code(f.run(), 'read')
    const denied = Object.assign(new Error('token=secret'), { code: 'gateway/internal' as const, details: {}, isDSHRemoteError: true as const })
    f.read.mockResolvedValueOnce({ ok: false, error: denied })
    await code(f.run(), 'read')
    expect(f.read).toHaveBeenCalledTimes(2)
  })
  it.each([{ offset: 1 }, { eof: false }, { bytes: 1 }, { absolutePath: 'relative.html' }])('refuses partial or inconsistent root %j', async extra => {
    const f = fixture('ok')
    f.read.mockResolvedValueOnce({ ok: true, value: file('ok', root, extra) })
    await code(f.run(), 'invalid')
  })
  it('accepts absent optional size while requiring complete bytes', async () => {
    const f = fixture('ok')
    const { bytes: _bytes, ...withoutSize } = file('ok')
    f.read.mockResolvedValueOnce({ ok: true, value: withoutSize })
    expect((await f.run()).html).toBe('ok')
  })
  it.each(['/work/else/a.png', '/work/demo-sibling/a.png', '/work/demo/../secret/a.png', 'D:\\other\\a.png'])('refuses canonical dependency escape %s', async path => {
    const f = fixture('<img src="child/a.png">')
    f.read.mockResolvedValueOnce({ ok: true, value: file('<img src="child/a.png">') }).mockResolvedValueOnce({ ok: true, value: file('x', path) })
    await code(f.run(), 'invalid')
    expect(f.read.mock.calls[1]?.[1]).toEqual({ baseFile: root })
  })
  it.each(['.txt', '.html?x'])('filters root extension before a Host call: %s', async suffix => {
    const read = vi.fn<LocalHtmlRead>()
    await code(prepareLocalHtml(session, `a${suffix}`, read, limits, new AbortController().signal), 'unsupported')
    expect(read).not.toHaveBeenCalled()
  })
  it.each([new Uint8Array([0xff]), new Uint8Array([0xc3])])('uses fatal UTF-8 decoding for root %j', async bytes => {
    await code(fixture(bytes).run(), 'invalid')
  })
  it.each(['script', 'stylesheet'])('uses fatal UTF-8 for %s assets', async kind => {
    const html = kind === 'script' ? '<script src="a.js"></script>' : '<link rel="stylesheet" href="a.css">'
    await code(fixture(html, { 'a.js': new Uint8Array([255]), 'a.css': new Uint8Array([255]) }).run(), 'invalid')
  })
})

describe('finite relative paths and explicitly unsupported dependency graphs', () => {
  it.each(['../a.png', 'sub/../../a.png', '/a.png', '//host/a.png', 'C:/a.png', 'C:a.png', '\\\\host\\a.png', 'sub\\a.png', '%2e%2e/a.png', 'sub/%2E%2E/a.png', '%2fa.png', 'sub%2fa.png', 'sub%5ca.png', '%252e%252e/a.png', '%00a.png', 'bad%ZZ.png', 'bad%E0%A4%A.png', 'a.png?bad=%ZZ', 'a.png#bad%ZZ'])('rejects unsafe reference before dependency reads: %s', async reference => {
    const f = fixture(`<img src="${reference}">`)
    await code(f.run(), /^[A-Za-z]:/u.test(reference) ? 'unsupported' : 'invalid')
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  it.each(['file:///a.png', 'javascript:alert(1)', 'ftp://host/a.png', 'dsh-resource://file/session/s/a.png'])('rejects unsupported schemes: %s', async reference => {
    await code(fixture(`<img src="${reference}">`).run(), 'unsupported')
  })
  it('prevalidates later unsafe references before reading earlier safe dependencies', async () => {
    const f = fixture('<img src="safe.png"><img src="../secret.png">')
    await code(f.run(), 'invalid')
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  it.each([
    '<base href="https://cdn.test/">', '<script type="module" src="a.js"></script>', '<script type="module">import "./a.js"</script>',
    '<script type=" module ">window.x=1</script>',
    '<img srcset="a.png 1x, b.png 2x">', '<picture><source srcset="a.png"></picture>',
    '<style>@import "a.css";</style>', '<style>body{background:url(a.png)}</style>', '<div style="background:url(a.png)"></div>',
    '<style>@\\69mport "a.css";</style>', '<script>import("./a.js")</script>', '<script>fetch("./data.json")</script>',
    '<script src="a.mjs"></script>', '<link rel="stylesheet" href="a.less">', '<img src="a.unknown">',
  ])('fails unsupported graphs without discovering more files: %s', async html => {
    const f = fixture(html)
    await code(f.run(), 'unsupported')
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  it.each(['@import "nested.css";', 'body{background:url(../image.png)}', 'body{background:u\\72l(image.png)}'])('does not traverse secondary CSS: %s', async css => {
    const f = fixture('<link rel="stylesheet" href="a.css">', { 'a.css': css })
    await code(f.run(), css.includes('../') ? 'invalid' : 'unsupported')
    expect(f.read).toHaveBeenCalledTimes(2)
  })
  it('never responds to page postMessage file commands', async () => {
    const f = fixture('<script>window.postMessage({path:"secret.png"},"*")</script>')
    await f.run()
    window.dispatchEvent(new MessageEvent('message', { data: { path: 'secret.png' } }))
    expect(f.read).toHaveBeenCalledTimes(1)
  })
})

describe('operation cancellation and total deadline', () => {
  it('does not read when already cancelled', async () => {
    const f = fixture('ok')
    const controller = new AbortController()
    controller.abort(new Error('secret abort reason'))
    await code(f.run({}, controller.signal), 'closed')
    expect(f.read).not.toHaveBeenCalled()
  })
  it('aborts a noncooperative in-flight callback and refuses late success', async () => {
    const f = fixture('ok')
    let finish!: (value: Awaited<ReturnType<LocalHtmlRead>>) => void
    f.read.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const controller = new AbortController()
    const pending = f.run({}, controller.signal)
    const outcome = code(pending, 'closed')
    controller.abort()
    await outcome
    expect(f.read.mock.calls[0]?.[2].aborted).toBe(true)
    finish({ ok: true, value: file('late') })
    expect(f.read).toHaveBeenCalledTimes(1)
  })
  it('prevents success when cancellation occurs inside the last asset read', async () => {
    const f = fixture('<img src="a.png">')
    const controller = new AbortController()
    f.read.mockResolvedValueOnce({ ok: true, value: file('<img src="a.png">') }).mockImplementationOnce(async () => {
      controller.abort()
      return { ok: true, value: file('x', '/work/demo/a.png') }
    })
    await code(f.run({}, controller.signal), 'closed')
  })
  it('bounds total elapsed time rather than granting each read another timeout', async () => {
    vi.useFakeTimers()
    const f = fixture('<img src="a.png"><img src="b.png">')
    f.read.mockImplementation(async path => {
      await new Promise(resolve => setTimeout(resolve, 40))
      return { ok: true, value: file(path === root ? '<img src="a.png"><img src="b.png">' : 'x', path === root ? root : `/work/demo/${path}`) }
    })
    const pending = f.run({ timeoutMs: 100 })
    const outcome = code(pending, 'timeout')
    await vi.advanceTimersByTimeAsync(100)
    await outcome
    expect(f.read).toHaveBeenCalledTimes(3)
    expect(f.read.mock.calls[2]?.[2].aborted).toBe(true)
    await vi.runAllTimersAsync()
  })
  it('normalizes all errors to stable content-free LocalHtmlError', async () => {
    const f = fixture('ok')
    f.read.mockRejectedValue(new Error('secret'))
    const error = await f.run().catch(value => value)
    expect(error).toBeInstanceOf(LocalHtmlError)
    expect(error.cause).toBeUndefined()
    expect(error.message).not.toContain('secret')
  })
})
