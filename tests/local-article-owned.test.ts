/** JSON script builders test NativePage routing and lifecycle only; runtime tests execute official Defuddle. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativePage } from '../src/browser/NativePage.ts'
import type { GuestLease, OwnedWebview } from '../src/browser/bridge.ts'
import type { LocalHtmlBundle, LocalHtmlCommand, LocalHtmlLimits } from '../src/browser/local-html-types.ts'

vi.mock('../src/browser/local-html-runtime.ts', () => ({
  localHtmlBootstrapScript: (bundle: LocalHtmlBundle, documentId: string, expectedBootstrapUrl: string, limits: LocalHtmlLimits) =>
    JSON.stringify({ kind: 'bootstrap', bundle, documentId, expectedBootstrapUrl, limits }),
  localHtmlCommandScript: (documentId: string, command: LocalHtmlCommand) => JSON.stringify({ ...command, documentId }),
  localHtmlDisposeScript: (documentId: string) => JSON.stringify({ kind: 'dispose', documentId }),
}))

const prepared = {
  bundle: {
    source: { path: 'E:\\reports\\canonical.html', resourceAddress: 'dsh-resource://file/session/origin/reports/canonical.html', version: 'authorized-v1' },
    title: 'Authorized report', html: '<article><h1>Offline article</h1></article>', assets: [],
  },
  limits: { maxBytes: 16 * 1024 * 1024, maxFiles: 12, timeoutMs: 1000 },
} satisfies { bundle: LocalHtmlBundle; limits: LocalHtmlLimits }
const article = { kind: 'article', title: 'Extracted article title', text: 'Extracted **article** 你好😀', format: 'markdown' }
let sequence = 0
const owned: NativePage[] = []
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
async function loaded() {
  const host = document.createElement('div')
  host.id = `local-article-${++sequence}`
  document.body.append(host)
  const bridge = {
    acquire: vi.fn(async () => ({ lease: `article-lease-${++sequence}` as GuestLease, partition: `article-partition-${sequence}` })),
    release: vi.fn(async (_lease: GuestLease) => {}),
    onOpenRequested: vi.fn((_lease: GuestLease, _listener: (url: string) => void) => () => {}),
  }
  const page = new NativePage(bridge, async () => 'cwd:authorized', 'https://app.test', async () => prepared)
  owned.push(page)
  page.mount(host.id, new AbortController().signal, undefined, vi.fn(), { path: 'report.html' })
  await vi.waitFor(() => { expect(host.querySelector('webview')).not.toBeNull() })
  const element = host.querySelector('webview') as OwnedWebview
  const state = { url: element.getAttribute('src')!, frameGeneration: 1, documentId: '', ready: true }
  const reply = (script: string): unknown => {
    const command = JSON.parse(script)
    if (command.kind === 'bootstrap') state.documentId = command.documentId
    if (command.kind === 'bootstrap' || command.kind === 'status') return { documentId: state.documentId, ready: state.ready, frameGeneration: state.frameGeneration }
    if (command.kind === 'article') return article
    if (command.kind === 'dispose') return true
    throw new Error(`Unexpected native article route: ${command.kind}`)
  }
  const executeJavaScript = vi.fn(async (script: string): Promise<unknown> => reply(script))
  Object.assign(element, {
    getURL: () => state.url, getTitle: () => 'Untrusted guest title', isLoading: () => false,
    loadURL: vi.fn(async (_url: string) => {}), clearHistory: vi.fn(), executeJavaScript,
  })
  element.dispatchEvent(new Event('dom-ready'))
  await vi.waitFor(() => { expect(page.getSnapshot().available).toBe(true) })
  return { page, state, reply, executeJavaScript, element }
}
afterEach(async () => {
  await Promise.all(owned.splice(0).map(page => page.dispose()))
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('owned local article capture route', () => {
  it('uses the broker between two status checks and keeps host-owned URL and local file fields', async () => {
    const f = await loaded()
    f.executeJavaScript.mockImplementation(async script => JSON.parse(script).kind === 'article' ? {
      ...article, url: 'file:///forged.html', path: 'C:/forged.html',
      localFile: { path: 'C:/forged.html', resourceAddress: 'cwd:forged', version: 'forged' },
    } : f.reply(script))
    await expect(f.page.capture('article', { maxBytes: 65536 })).resolves.toEqual({
      ...article, url: prepared.bundle.source.resourceAddress, localFile: prepared.bundle.source,
    })
    const commands = f.executeJavaScript.mock.calls.map(([script]) => JSON.parse(script))
    expect(commands.map(command => command.kind)).toEqual(['bootstrap', 'status', 'article', 'status'])
    expect(commands[2]).toEqual({ kind: 'article', maxBytes: 65536, documentId: f.state.documentId })
  })

  it.each(['no-article', 'too-large', 'failed'])('contains broker %s failures without returning source text', async code => {
    const f = await loaded()
    f.executeJavaScript.mockImplementation(async script => JSON.parse(script).kind === 'article' ? { code } : f.reply(script))
    await expect(f.page.capture('article', { maxBytes: 65536 })).rejects.toMatchObject({ code })
  })

  it('refuses an unready document before sending article to the broker', async () => {
    const f = await loaded()
    f.state.ready = false
    await expect(f.page.capture('article', { maxBytes: 65536 })).rejects.toMatchObject({ code: 'changed' })
    expect(f.executeJavaScript.mock.calls.map(([script]) => JSON.parse(script).kind)).toEqual(['bootstrap', 'status'])
  })

  it('rejects a frame generation change between the two status checks', async () => {
    const f = await loaded()
    f.executeJavaScript.mockImplementation(async script => {
      if (JSON.parse(script).kind === 'article') { f.state.frameGeneration++; return article }
      return f.reply(script)
    })
    await expect(f.page.capture('article', { maxBytes: 65536 })).rejects.toMatchObject({ code: 'changed' })
    expect(f.executeJavaScript.mock.calls.map(([script]) => JSON.parse(script).kind)).toEqual(['bootstrap', 'status', 'article', 'status'])
  })

  it('rejects physical guest navigation while an article request is pending', async () => {
    const f = await loaded()
    const pending = deferred<unknown>()
    f.executeJavaScript.mockImplementation(async script => JSON.parse(script).kind === 'article' ? pending.promise : f.reply(script))
    const outcome = f.page.capture('article', { maxBytes: 65536 }).then(value => ({ value }), (error: unknown) => ({ error }))
    await vi.waitFor(() => { expect(f.executeJavaScript.mock.calls.some(([script]) => JSON.parse(script).kind === 'article')).toBe(true) })
    f.state.url = 'https://example.test/replacement'
    pending.resolve(article)
    expect(await outcome).toMatchObject({ error: { code: 'changed' } })
  })

  it('does not return a late article after disposal', async () => {
    const f = await loaded()
    const pending = deferred<unknown>()
    f.executeJavaScript.mockImplementation(async script => JSON.parse(script).kind === 'article' ? pending.promise : f.reply(script))
    const outcome = f.page.capture('article', { maxBytes: 65536 }).then(value => ({ value }), (error: unknown) => ({ error }))
    await vi.waitFor(() => { expect(f.executeJavaScript.mock.calls.some(([script]) => JSON.parse(script).kind === 'article')).toBe(true) })
    await f.page.dispose()
    pending.resolve(article)
    expect(await outcome).toMatchObject({ error: { code: 'closed' } })
    expect(f.element.isConnected).toBe(false)
  })
})
