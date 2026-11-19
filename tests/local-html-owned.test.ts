/** NativePage lifecycle tests with JSON script stubs; local-html-runtime tests exercise the real isolated-frame scripts. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativePage } from '../src/browser/NativePage.ts'
import type { LocalHtmlLoader } from '../src/browser/NativePage.ts'
import type { GuestLease, OwnedWebview } from '../src/browser/bridge.ts'
import { LocalHtmlError } from '../src/browser/local-html-types.ts'
import type { LocalHtmlBundle, LocalHtmlCommand, LocalHtmlLimits } from '../src/browser/local-html-types.ts'

vi.mock('../src/browser/local-html-runtime.ts', () => ({
  localHtmlBootstrapScript: (bundle: LocalHtmlBundle, documentId: string, expectedBootstrapUrl: string, limits: LocalHtmlLimits) =>
    JSON.stringify({ kind: 'bootstrap', bundle, documentId, expectedBootstrapUrl, limits }),
  localHtmlCommandScript: (documentId: string, command: LocalHtmlCommand) => JSON.stringify({ ...command, documentId }),
  localHtmlDisposeScript: (documentId: string) => JSON.stringify({ kind: 'dispose', documentId }),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const prepared = {
  bundle: {
    source: { path: 'E:\\reports\\canonical.html', resourceAddress: 'dsh-resource://file/session/origin/reports/canonical.html', version: 'authorized-v1' },
    title: 'Authorized report', html: '<h1>Fixture document</h1>', assets: [],
  },
  limits: { maxBytes: 65536, maxFiles: 12, timeoutMs: 1000 },
} satisfies { bundle: LocalHtmlBundle; limits: LocalHtmlLimits }
const picked = { element: {
  tag: 'h1', selector: 'h1:nth-of-type(1)', role: 'heading', label: '', text: 'Fixture document',
  // The broker has mapped the opaque child-frame rectangle into native viewport coordinates.
  rect: { x: 17, y: 34, width: 120, height: 28 },
  viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 },
} }
let sequence = 0
const owned: NativePage[] = []
function fixture(loader: LocalHtmlLoader = async () => prepared) {
  const host = document.createElement('div')
  host.id = `local-owned-${++sequence}`
  document.body.append(host)
  const bridge = {
    acquire: vi.fn(async () => ({ lease: `local-lease-${++sequence}` as GuestLease, partition: `local-partition-${sequence}` })),
    release: vi.fn(async (_lease: GuestLease) => {}),
    onOpenRequested: vi.fn((_lease: GuestLease, _listener: (url: string) => void) => () => {}),
  }
  const read = vi.fn(loader)
  const page = new NativePage(bridge, async () => 'cwd:authorized', 'https://app.test', read)
  const lifetime = new AbortController()
  owned.push(page)
  const mount = () => page.mount(host.id, lifetime.signal, undefined, vi.fn(), { path: 'report.html' })
  async function guest() {
    await vi.waitFor(() => { expect(host.querySelector('webview')).not.toBeNull() })
    const element = host.querySelector('webview') as OwnedWebview
    const state = { url: element.getAttribute('src')!, frameGeneration: 1, documentId: '' }
    const reply = (script: string): unknown => {
      const command = JSON.parse(script)
      if (command.kind === 'bootstrap') state.documentId = command.documentId
      if (command.kind === 'bootstrap' || command.kind === 'status') return { documentId: state.documentId, ready: true, frameGeneration: state.frameGeneration }
      if (command.kind === 'selection') return { text: 'Authorized selection' }
      if (command.kind === 'article') return { kind: 'article', title: 'Rendered article', text: '# Article body', format: 'markdown' }
      if (command.kind === 'pick' || command.kind === 'check') return picked
      return true
    }
    const native = {
      getURL: vi.fn(() => state.url), getTitle: vi.fn(() => 'Untrusted guest title'), isLoading: () => false,
      loadURL: vi.fn(async (_url: string) => {}), clearHistory: vi.fn(),
      executeJavaScript: vi.fn(async (script: string): Promise<unknown> => reply(script)),
      capturePage: vi.fn(async () => ({ toDataURL: () => 'data:image/png;base64,iVBORw==' })),
    }
    Object.assign(element, native)
    const emit = (name: string, fields: object = {}) => element.dispatchEvent(Object.assign(new Event(name), fields))
    return { element, state, reply, ...native, emit }
  }
  return { page, host, bridge, read, mount, guest, lifetime }
}
async function loaded() {
  const h = fixture()
  h.mount()
  const guest = await h.guest()
  guest.emit('dom-ready')
  await vi.waitFor(() => { expect(h.page.getSnapshot().available).toBe(true) })
  return { h, guest }
}
afterEach(async () => {
  await Promise.all(owned.splice(0).map(page => page.dispose()))
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('owned local HTML guest lifecycle', () => {
  it('does not expose a page before authorized reading and isolated-shell readiness', async () => {
    const reading = deferred<typeof prepared>()
    const h = fixture(() => reading.promise)
    h.mount()
    await vi.waitFor(() => { expect(h.read).toHaveBeenCalledTimes(1) })
    expect(h.read.mock.calls[0]![0]).toEqual({ path: 'report.html' })
    expect(h.page.getSnapshot()).toMatchObject({ available: false, observed: false, loading: true, localPath: 'report.html' })
    expect(h.host.querySelector('webview')).toBeNull()
    await expect(h.page.capture('selection', { maxBytes: 65536 })).rejects.toMatchObject({ code: 'unavailable' })
    reading.resolve(prepared)
    const guest = await h.guest()
    expect(guest.element.getAttribute('src')).toBe(`about:blank#${guest.element.getAttribute('name')}`)
    expect(guest.element.getAttribute('src')).not.toContain('file:')
    expect(h.page.getSnapshot().available).toBe(false)
    const bootstrap = deferred<unknown>()
    guest.executeJavaScript.mockReturnValueOnce(bootstrap.promise)
    guest.emit('dom-ready')
    expect(h.page.getSnapshot().available).toBe(false)
    const command = JSON.parse(guest.executeJavaScript.mock.calls[0]![0])
    expect(command).toMatchObject({ kind: 'bootstrap', expectedBootstrapUrl: guest.state.url, limits: prepared.limits })
    bootstrap.resolve({ documentId: command.documentId, ready: true, frameGeneration: 1 })
    await vi.waitFor(() => { expect(h.page.getSnapshot().available).toBe(true) })
    expect(h.page.getSnapshot()).toMatchObject({ url: prepared.bundle.source.resourceAddress, localFile: prepared.bundle.source, title: prepared.bundle.title })
    expect(guest.loadURL).not.toHaveBeenCalled()
  })

  it('keeps authorized metadata in selection and native viewport captures', async () => {
    const { h, guest } = await loaded()
    await expect(h.page.capture('selection', { maxBytes: 65536 })).resolves.toMatchObject({
      kind: 'selection', text: 'Authorized selection', url: prepared.bundle.source.resourceAddress, title: prepared.bundle.title, localFile: prepared.bundle.source,
    })
    const commands = guest.executeJavaScript.mock.calls.map(([script]) => JSON.parse(script).kind)
    expect(commands).toEqual(['bootstrap', 'status', 'selection', 'status'])
    await expect(h.page.capture('viewport', { maxBytes: 65536 })).resolves.toMatchObject({ kind: 'viewport', localFile: prepared.bundle.source })
    expect(guest.capturePage).toHaveBeenCalledTimes(1)
    await expect(h.page.capture('article', { maxBytes: 65536 })).resolves.toMatchObject({
      kind: 'article', format: 'markdown', text: '# Article body', url: prepared.bundle.source.resourceAddress, localFile: prepared.bundle.source,
    })
    expect(guest.state.url).toMatch(/^about:blank#local-lease-/u)
  })

  it('rereads a reload and gives the replacement guest a fresh lease', async () => {
    const { h, guest } = await loaded()
    const oldLease = guest.element.getAttribute('name')
    h.page.reload()
    expect(h.page.getSnapshot().available).toBe(false)
    expect(guest.element.isConnected).toBe(false)
    const replacement = await h.guest()
    expect(replacement.element).not.toBe(guest.element)
    expect(replacement.element.getAttribute('name')).not.toBe(oldLease)
    expect(h.read).toHaveBeenCalledTimes(2)
    expect(h.read.mock.calls[0]![1].aborted).toBe(true)
    expect(h.read.mock.calls[1]![0]).toEqual({ path: prepared.bundle.source.path })
    replacement.emit('dom-ready')
    await vi.waitFor(() => { expect(h.page.getSnapshot().available).toBe(true) })
    expect(h.bridge.release).toHaveBeenCalledWith(oldLease)
  })

  it.each(['url', 'close'] as const)('cancels pending authorized reads after %s without late local success', async action => {
    const reading = deferred<typeof prepared>()
    const h = fixture(() => reading.promise)
    h.mount()
    await vi.waitFor(() => { expect(h.read).toHaveBeenCalledTimes(1) })
    if (action === 'url') h.page.loadUrl('https://example.test/next')
    else await h.page.dispose()
    expect(h.read.mock.calls[0]![1].aborted).toBe(true)
    reading.resolve(prepared)
    await reading.promise
    await Promise.resolve()
    expect(h.page.getSnapshot().localFile).toBeUndefined()
    expect(h.page.getSnapshot().available).toBe(false)
    if (action === 'url') {
      const guest = await h.guest()
      guest.emit('dom-ready')
      expect(guest.loadURL).toHaveBeenCalledWith('https://example.test/next')
      expect(guest.executeJavaScript).not.toHaveBeenCalled()
    } else expect(h.host.querySelector('webview')).toBeNull()
  })

  it('invalidates a captured local document after opaque child-frame navigation', async () => {
    const { h, guest } = await loaded()
    guest.emit('did-start-navigation', { isMainFrame: false, isInPlace: false })
    expect(h.page.getSnapshot()).toMatchObject({ available: false, error: 'local-changed', observed: false })
    await expect(h.page.capture('viewport', { maxBytes: 65536 })).rejects.toMatchObject({ code: 'unavailable' })
    expect(guest.capturePage).not.toHaveBeenCalled()
  })

  it('rejects a native capture when the broker frame generation changes during capture', async () => {
    const { h, guest } = await loaded()
    guest.capturePage.mockImplementationOnce(async () => {
      guest.state.frameGeneration++
      return { toDataURL: () => 'data:image/png;base64,iVBORw==' }
    })
    await expect(h.page.capture('viewport', { maxBytes: 65536 })).rejects.toMatchObject({ code: 'changed' })
    expect(guest.capturePage).toHaveBeenCalledTimes(1)
  })

  it('routes local picking, verification and cleanup through the broker and retains mapped viewport bounds', async () => {
    const { h, guest } = await loaded()
    const result = await h.page.pickElement({ maxTextBytes: 65536, maxImageBytes: 65536 }, new AbortController().signal, 'Pick a report heading')
    expect(result.element).toEqual(picked.element)
    expect(result.image).toMatchObject({ kind: 'viewport', url: prepared.bundle.source.resourceAddress, localFile: prepared.bundle.source })
    const commands = guest.executeJavaScript.mock.calls.map(([script]) => JSON.parse(script))
    expect(commands.map(command => command.kind)).toEqual(['bootstrap', 'status', 'pick', 'check', 'status', 'check', 'status', 'cancel'])
    const pick = commands.find(command => command.kind === 'pick')!
    expect(pick).toMatchObject({ documentId: guest.state.documentId, instruction: 'Pick a report heading', maxBytes: 65536 })
    expect(commands.filter(command => command.kind === 'check' || command.kind === 'cancel').every(command => command.nonce === pick.nonce && command.documentId === pick.documentId)).toBe(true)
    expect(guest.capturePage).toHaveBeenCalledExactlyOnceWith()
  })

  it('cancels a pending local picker with broker cleanup rather than a top-level page reader', async () => {
    const { h, guest } = await loaded()
    const picking = deferred<unknown>()
    guest.executeJavaScript.mockImplementation(async script => JSON.parse(script).kind === 'pick' ? picking.promise : guest.reply(script))
    const controller = new AbortController()
    const operation = h.page.pickElement({ maxTextBytes: 65536, maxImageBytes: 65536 }, controller.signal, 'Pick')
    const rejected = expect(operation).rejects.toMatchObject({ code: 'cancelled' })
    await vi.waitFor(() => { expect(guest.executeJavaScript.mock.calls.some(([script]) => JSON.parse(script).kind === 'pick')).toBe(true) })
    controller.abort()
    await rejected
    expect(guest.executeJavaScript.mock.calls.some(([script]) => JSON.parse(script).kind === 'cancel')).toBe(true)
    expect(guest.capturePage).not.toHaveBeenCalled()
    picking.resolve({ code: 'cancelled' })
  })

  it.each(['read', 'limit', 'config'] as const)('exposes a bounded local-%s failure without initializing a guest', async code => {
    const h = fixture(async () => { throw new LocalHtmlError(code) })
    h.mount()
    await vi.waitFor(() => { expect(h.page.getSnapshot().error).toBe(`local-${code}`) })
    expect(h.page.getSnapshot()).toMatchObject({ loading: false, available: false, observed: false })
    expect(h.bridge.acquire).not.toHaveBeenCalled()
    expect(h.host.querySelector('webview')).toBeNull()
  })

  it('contains a bootstrap request that exceeds the configured finite deadline', async () => {
    const h = fixture(async () => ({ ...prepared, limits: { ...prepared.limits, timeoutMs: 20 } }))
    h.mount()
    const guest = await h.guest()
    const hanging = deferred<unknown>()
    guest.executeJavaScript.mockReturnValueOnce(hanging.promise)
    guest.emit('dom-ready')
    await vi.waitFor(() => { expect(h.page.getSnapshot().error).toBe('local-timeout') })
    expect(h.page.getSnapshot().available).toBe(false)
    hanging.resolve({ documentId: 'late', ready: true, frameGeneration: 1 })
    await Promise.resolve()
    expect(h.page.getSnapshot().available).toBe(false)
  })
})
