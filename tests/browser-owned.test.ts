import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId, WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { NativePage } from '../src/browser/NativePage.ts'
import type { OwnedWebview, GuestLease } from '../src/browser/bridge.ts'
import { browserBridge } from '../src/browser/bridge.ts'
import { workspaceKey } from '../src/browser/workspace.ts'
import { CaptureError } from '../src/browser/capture.ts'
import { selectionScript } from '../src/browser/selection.ts'
import { wecomSelectionScript } from '../src/readers/wecom-selection.ts'
import { bilibiliVideoScript } from '../src/readers/bilibili.ts'

const URL = 'https://example.test/article'
const fixtures: ReturnType<typeof fixture>[] = []
// Native bridge replies are explicitly stubbed here; real Defuddle extraction has its own reader fixtures.
beforeEach(() => { vi.stubGlobal('__BROWSER_CONTEXT_DEFUDDLE__', '') })
let sequence = 0
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function fixture() {
  const host = document.createElement('div')
  host.id = `reference-browser-${++sequence}`
  document.body.append(host)
  const reservation = { lease: `owned-${sequence}` as GuestLease, partition: `partition-${sequence}` }
  const stopOpen = vi.fn()
  let opened: ((url: string) => void) | undefined
  const bridge = {
    acquire: vi.fn(async (_workspace: string) => reservation), release: vi.fn(async (_lease: GuestLease) => {}),
    onOpenRequested: vi.fn((_lease: GuestLease, listener: (url: string) => void) => { opened = listener; return stopOpen }),
  }
  const workspace = vi.fn(async (_signal: AbortSignal) => 'cwd:/canonical')
  const lifetime = new AbortController()
  const open = vi.fn()
  const page = new NativePage(bridge, workspace, 'https://app.test')
  const mount = () => page.mount(host.id, lifetime.signal, undefined, open)
  return { page, host, reservation, bridge, workspace, lifetime, open, stopOpen, opened: () => opened,
    mount, async guest() {
      await vi.waitFor(() => { expect(host.querySelector('webview')).not.toBeNull() })
      const element = host.querySelector('webview') as OwnedWebview
      const state = { url: `about:blank#${reservation.lease}`, title: '', loading: true }
      const native = {
        loadURL: vi.fn(async (_url: string) => {}), getURL: vi.fn(() => state.url), getTitle: () => state.title,
        isLoading: () => state.loading, clearHistory: vi.fn(),
        executeJavaScript: vi.fn<(_script: string) => Promise<unknown>>(async () => ({ text: 'Selected text' })),
        capturePage: vi.fn(async () => ({ toDataURL: () => 'data:image/png;base64,iVBORw==' })),
      }
      Object.assign(element, native)
      const emit = (name: string, fields: object = {}) => element.dispatchEvent(Object.assign(new Event(name), fields))
      return { element, state, ...native, emit }
    },
  }
}
async function loaded(target = URL) {
  const h = fixture()
  fixtures.push(h)
  h.mount()
  h.page.loadUrl(target)
  const guest = await h.guest()
  guest.emit('dom-ready')
  guest.state.url = target
  guest.state.title = 'Observed 标题'
  guest.state.loading = false
  guest.emit('did-navigate')
  guest.emit('did-stop-loading')
  return { h, guest }
}
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(h => h.page.dispose()))
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('owned video capture', () => {
  const videoUrl = 'https://www.bilibili.com/video/BV1234567890/?p=2'
  const payload = { kind: 'video', url: videoUrl, title: '视频😀', text: 'Video page information\n字幕片段😀', format: 'text', coverage: 'loaded', subtitleStatus: 'loaded' }
  const limits = { maxBytes: 65536, subtitleRequestTimeoutMs: 15000 }
  it.each(['object', 'json'])('captures a video snapshot with explicit limits (%s IPC)', async encoding => {
    const { h, guest } = await loaded(videoUrl)
    expect(guest.executeJavaScript).not.toHaveBeenCalled()
    guest.executeJavaScript.mockResolvedValue(encoding === 'json' ? JSON.stringify(payload) : payload)
    await expect(h.page.capture('video', limits)).resolves.toEqual(payload)
    expect(guest.executeJavaScript).toHaveBeenCalledExactlyOnceWith(bilibiliVideoScript(65536, 15000))
    expect(guest.capturePage).not.toHaveBeenCalled()
    const bytes = new TextEncoder().encode(JSON.stringify(payload)).byteLength
    await expect(h.page.capture('video', { ...limits, maxBytes: bytes })).resolves.toEqual(payload)
    await expect(h.page.capture('video', { ...limits, maxBytes: bytes - 1 })).rejects.toMatchObject({ code: 'too-large' })
  })
  it('preserves partial metadata and a declared subtitle failure without a capture fallback', async () => {
    const { h, guest } = await loaded(videoUrl)
    const partial = { ...payload, subtitleStatus: 'not-loaded', subtitleReason: 'login-required' }
    guest.executeJavaScript.mockResolvedValue({ ...partial, privateSubtitleUrl: 'do-not-project' })
    await expect(h.page.capture('video', limits)).resolves.toEqual(partial)
    expect(guest.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(guest.capturePage).not.toHaveBeenCalled()
  })
  it.each([undefined, 0, -1, 1.5, Infinity, 2147483648])('rejects invalid subtitle timeout %s before calling the guest', async timeout => {
    const { h, guest } = await loaded(videoUrl)
    await expect(h.page.capture('video', { maxBytes: 65536, ...(timeout === undefined ? {} : { subtitleRequestTimeoutMs: timeout }) })).rejects.toMatchObject({ code: 'invalid-limit' })
    expect(guest.executeJavaScript).not.toHaveBeenCalled()
  })
  it('rejects wrong pages and generic article extraction on a video page', async () => {
    const { h, guest } = await loaded()
    await expect(h.page.capture('video', limits)).rejects.toMatchObject({ code: 'unsupported' })
    guest.state.url = videoUrl
    guest.emit('did-navigate')
    await expect(h.page.capture('article', limits)).rejects.toMatchObject({ code: 'unsupported' })
    expect(guest.executeJavaScript).not.toHaveBeenCalled()
  })
  it.each([{ code: 'no-video' }, { ...payload, coverage: 'complete' }, { ...payload, subtitleReason: 'timeout' }])('rejects unavailable or misreported video responses', async response => {
    const { h, guest } = await loaded(videoUrl)
    guest.executeJavaScript.mockResolvedValue(response)
    await expect(h.page.capture('video', limits)).rejects.toMatchObject({ code: 'code' in response ? 'no-video' : 'failed' })
    expect(guest.executeJavaScript).toHaveBeenCalledTimes(1)
    expect(guest.capturePage).not.toHaveBeenCalled()
  })
  it('rejects a pending video response after navigation', async () => {
    const { h, guest } = await loaded(videoUrl)
    const pending = deferred<unknown>()
    guest.executeJavaScript.mockReturnValueOnce(pending.promise)
    const result = h.page.capture('video', limits)
    guest.state.url = 'https://www.bilibili.com/video/BV0987654321/'
    guest.emit('did-navigate')
    pending.resolve(payload)
    await expect(result).rejects.toMatchObject({ code: 'changed' })
  })
})

describe('owned Melo selection routing', () => {
  const documentUrl = 'https://doc.weixin.qq.com/doc/fixture'
  it.each(['object', 'json'] as const)('returns only the selected text from one explicit Melo reader call (%s IPC)', async encoding => {
    const { h, guest } = await loaded(documentUrl)
    const reply = { text: '实际选择的文字\n第二行' }
    guest.executeJavaScript.mockResolvedValue(encoding === 'json' ? JSON.stringify(reply) : reply)
    expect(guest.executeJavaScript).not.toHaveBeenCalled()
    await expect(h.page.capture('selection', { maxBytes: 65536 })).resolves.toEqual({
      kind: 'selection', url: documentUrl, title: 'Observed 标题', text: reply.text,
    })
    expect(guest.executeJavaScript).toHaveBeenCalledExactlyOnceWith(wecomSelectionScript(65536))
    expect(guest.capturePage).not.toHaveBeenCalled()
  })
  it('keeps the normal focused-DOM reader for an ordinary webpage', async () => {
    const { h, guest } = await loaded()
    await expect(h.page.capture('selection', { maxBytes: 65536 })).resolves.toMatchObject({ kind: 'selection', text: 'Selected text' })
    expect(guest.executeJavaScript).toHaveBeenCalledExactlyOnceWith(selectionScript(65536))
  })
  it('bounds Melo text together with final URL, title, kind and escaped UTF-8 JSON bytes', async () => {
    const { h, guest } = await loaded(documentUrl)
    const text = '多字节选区\n"引号"\\末尾'
    guest.executeJavaScript.mockResolvedValue({ text })
    const expected = { kind: 'selection', url: documentUrl, title: 'Observed 标题', text }
    const exact = new TextEncoder().encode(JSON.stringify(expected)).byteLength
    await expect(h.page.capture('selection', { maxBytes: exact })).resolves.toEqual(expected)
    await expect(h.page.capture('selection', { maxBytes: exact - 1 })).rejects.toMatchObject({ code: 'too-large' })
    expect(guest.executeJavaScript.mock.calls.map(call => call[0])).toEqual([
      wecomSelectionScript(exact), wecomSelectionScript(exact - 1),
    ])
  })
  it.each([
    ['copy-denied', 'permission', 'copy-denied'],
    ['unsupported', 'abi', 'melo-unavailable'],
    ['unsupported', 'selection', 'melo-range-unavailable'],
    ['empty-selection', 'selection', 'empty-selection'],
  ] as const)('contains %s failures without invoking a DOM reader fallback', async (code, stage, expected) => {
    const { h, guest } = await loaded(documentUrl)
    guest.executeJavaScript.mockResolvedValue({ code, stage, unexpected: 'PRIVATE_GUEST_VALUE' })
    const failure: unknown = await h.page.capture('selection', { maxBytes: 65536 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CaptureError)
    if (!(failure instanceof CaptureError)) throw new Error('Expected a capture failure')
    expect(failure.code).toBe(expected)
    expect(failure.cause).toBeInstanceOf(Error)
    if (!(failure.cause instanceof Error)) throw new Error('Expected fixed reader diagnostics')
    expect(failure.cause.message).toBe(`Melo selection stage: ${stage}`)
    expect(guest.executeJavaScript).toHaveBeenCalledExactlyOnceWith(wecomSelectionScript(65536))
    expect(guest.capturePage).not.toHaveBeenCalled()
  })
  it.each(['unsupported', 'failed'] as const)('contains validated range diagnostics for %s without echoing guest values', async code => {
    const { h, guest } = await loaded(documentUrl)
    const info = { kind: 'array', members: [{ name: 'length', type: 'number', depth: 0 }], truncated: false,
      firstItem: { members: [{ name: 'begin', type: 'function', depth: 1, definition: 'begin(){return this.start}' },
        { name: 'end', type: 'function', depth: 1 }], truncated: false } }
    guest.executeJavaScript.mockResolvedValue({ code, stage: 'selection', unexpected: 'PRIVATE_REPLY_VALUE',
      selectionInfo: { ...info, privateValue: 'PRIVATE_SELECTION_VALUE',
        members: info.members.map(member => ({ ...member, value: 'PRIVATE_MEMBER_VALUE' })),
        firstItem: { ...info.firstItem, value: 'PRIVATE_FIRST_ITEM',
          members: info.firstItem.members.map(member => ({ ...member, value: 'PRIVATE_RANGE_VALUE' })) } } })
    const failure: unknown = await h.page.capture('selection', { maxBytes: 65536 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CaptureError)
    if (!(failure instanceof CaptureError)) throw new Error('Expected a capture failure')
    expect(failure.code).toBe(code === 'unsupported' ? 'melo-range-unavailable' : 'failed')
    expect(failure.cause).toBeInstanceOf(Error)
    if (!(failure.cause instanceof Error)) throw new Error('Expected validated selection diagnostics')
    expect(failure.cause.message).toBe(`Melo selection stage: selection\nselectionInfo: ${JSON.stringify(info)}`)
    expect(failure.cause.message).not.toContain('PRIVATE_')
    expect(guest.executeJavaScript).toHaveBeenCalledExactlyOnceWith(wecomSelectionScript(65536))
    expect(guest.capturePage).not.toHaveBeenCalled()
  })
  it.each([
    { name: 'member count', members: Array.from({ length: 33 }, (_, i) => ({ name: `m${i}`, type: 'object', depth: 0 })) },
    { name: 'prototype depth', members: [{ name: 'begin', type: 'function', depth: 4 }] },
    { name: 'UTF-8 definition size', members: [{ name: 'begin', type: 'function', depth: 1, definition: '界'.repeat(342) }] },
  ])('refuses invalid selectionInfo $name before publishing range diagnostics', async ({ members }) => {
    const { h, guest } = await loaded(documentUrl)
    guest.executeJavaScript.mockResolvedValue({ code: 'unsupported', stage: 'selection', unexpected: 'PRIVATE_REPLY_VALUE',
      selectionInfo: { kind: 'object', members, truncated: false } })
    const failure: unknown = await h.page.capture('selection', { maxBytes: 65536 }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(CaptureError)
    if (!(failure instanceof CaptureError)) throw new Error('Expected a capture failure')
    expect(failure.code).toBe('failed')
    expect(failure.cause).toBeUndefined()
    expect(failure.message).toBe('Reference browser capture: failed')
    expect(guest.executeJavaScript).toHaveBeenCalledExactlyOnceWith(wecomSelectionScript(65536))
    expect(guest.capturePage).not.toHaveBeenCalled()
  })
  it.each(['navigation', 'same-url-loading', 'reload'] as const)('rejects an in-flight Melo reply after %s', async change => {
    const { h, guest } = await loaded(documentUrl)
    const reply = deferred<unknown>()
    guest.executeJavaScript.mockReturnValueOnce(reply.promise)
    const capture = h.page.capture('selection', { maxBytes: 65536 })
    if (change === 'navigation') h.page.loadUrl('https://example.test/next')
    else if (change === 'same-url-loading') guest.emit('did-start-loading')
    else h.page.reload()
    reply.resolve({ text: 'Old selection must not be admitted' })
    await expect(capture).rejects.toMatchObject({ code: 'changed' })
    expect(guest.executeJavaScript).toHaveBeenCalledExactlyOnceWith(wecomSelectionScript(65536))
  })
})

describe('owned WeCom snapshot integration', () => {
  it('projects only a loaded document snapshot and enforces complete final metadata budgets', async () => {
    const { h, guest } = await loaded()
    const docUrl = 'https://doc.weixin.qq.com/doc/fixture'
    guest.state.url = docUrl
    guest.emit('did-navigate')
    guest.emit('did-stop-loading')
    const raw = { status: 'ok', url: docUrl, title: 'Loaded document', text: '已加载正文，非全文证明', format: 'text', coverage: 'loaded' }
    guest.executeJavaScript.mockResolvedValue(raw)
    const result = { kind: 'document', url: docUrl, title: raw.title, text: raw.text, format: 'text', coverage: 'loaded' }
    const size = new TextEncoder().encode(JSON.stringify(result)).byteLength
    await expect(h.page.capture('document', { maxBytes: size })).resolves.toEqual(result)
    await expect(h.page.capture('document', { maxBytes: size - 1 })).rejects.toMatchObject({ code: 'too-large' })
    guest.executeJavaScript.mockClear()
    await expect(h.page.capture('document', { maxBytes: 0 })).rejects.toMatchObject({ code: 'too-large' })
    expect(guest.executeJavaScript).not.toHaveBeenCalled()
    await expect(h.page.capture('article', { maxBytes: 65536 })).rejects.toMatchObject({ code: 'unsupported' })
  })
  it('never executes a document reader on an unrelated page or accepts invented complete coverage', async () => {
    const { h, guest } = await loaded()
    await expect(h.page.capture('document', { maxBytes: 65536 })).rejects.toMatchObject({ code: 'unsupported' })
    expect(guest.executeJavaScript).not.toHaveBeenCalled()
    const docUrl = 'https://doc.weixin.qq.com/doc/fixture'
    guest.state.url = docUrl
    guest.emit('did-navigate')
    guest.emit('did-stop-loading')
    guest.executeJavaScript.mockResolvedValue({ status: 'ok', url: docUrl, title: 'Document', text: 'not validated as complete', format: 'text', coverage: 'complete' })
    await expect(h.page.capture('document', { maxBytes: 65536 })).rejects.toMatchObject({ code: 'failed' })
  })
})

describe('owned reference-browser native carrier', () => {
  it('uses the stock lease bootstrap and same-CWD reservation without any stock Browser element', async () => {
    const { h, guest } = await loaded()
    expect(h.bridge.acquire).toHaveBeenCalledExactlyOnceWith('cwd:/canonical')
    expect(guest.element.getAttribute('name')).toBe(h.reservation.lease)
    expect(guest.element.getAttribute('partition')).toBe(h.reservation.partition)
    expect(guest.element.getAttribute('src')).toBe(`about:blank#${h.reservation.lease}`)
    expect(guest.element.hasAttribute('preload')).toBe(false)
    expect(guest.element.hasAttribute('nodeintegration')).toBe(false)
    expect(guest.loadURL).toHaveBeenCalledExactlyOnceWith(URL)
    expect(h.page.getSnapshot()).toMatchObject({ available: true, observed: true, url: URL, title: guest.state.title })
    h.opened()?.('https://example.test/popup')
    expect(h.open).toHaveBeenCalledExactlyOnceWith('https://example.test/popup')
    await h.page.dispose()
    expect(h.stopOpen).toHaveBeenCalledOnce()
    expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
    expect(h.host.childElementCount).toBe(0)
  })

  it('captures only selection or viewport and applies complete metadata and PNG budgets', async () => {
    const { h, guest } = await loaded()
    const selected = await h.page.capture('selection', { maxBytes: 4096 })
    expect(selected).toEqual({ kind: 'selection', url: URL, title: guest.state.title, text: 'Selected text' })
    const size = new TextEncoder().encode(JSON.stringify(selected)).byteLength
    await expect(h.page.capture('selection', { maxBytes: size })).resolves.toEqual(selected)
    await expect(h.page.capture('selection', { maxBytes: size - 1 })).rejects.toMatchObject({ code: 'too-large' })
    await expect(h.page.capture('selection', { maxBytes: Infinity })).rejects.toMatchObject({ code: 'invalid-limit' })
    await expect(h.page.capture('viewport', { maxBytes: 4096 })).resolves.toMatchObject({
      kind: 'viewport', bytes: new Uint8Array([137, 80, 78, 71]),
    })
    const article = { kind: 'article' as const, url: URL, title: 'Parsed article', text: '## Article', format: 'markdown' as const }
    guest.executeJavaScript.mockResolvedValue(article)
    const articleSize = new TextEncoder().encode(JSON.stringify(article)).byteLength
    await expect(h.page.capture('article', { maxBytes: articleSize })).resolves.toEqual(article)
    await expect(h.page.capture('article', { maxBytes: articleSize - 1 })).rejects.toMatchObject({ code: 'too-large' })
    guest.executeJavaScript.mockResolvedValue({ code: 'no-article' })
    await expect(h.page.capture('article', { maxBytes: 4096 })).rejects.toMatchObject({ code: 'no-article' })
    guest.executeJavaScript.mockResolvedValue({ ...article, url: 'https://wrong.test/' })
    await expect(h.page.capture('article', { maxBytes: 4096 })).rejects.toMatchObject({ code: 'failed' })
    guest.executeJavaScript.mockResolvedValue({ code: 'empty-selection' })
    await expect(h.page.capture('selection', { maxBytes: 4096 })).rejects.toMatchObject({ code: 'empty-selection' })
    expect(guest.capturePage).toHaveBeenCalledOnce()
  })

  it.each((['selection', 'article'] as const).flatMap(kind =>
    (['reload', 'navigation', 'same-url-navigation', 'replacement', 'closed'] as const).map(change => ({ kind, change }))))(
    'invalidates pending $kind capture on $change', async ({ kind, change }) => {
    const { h, guest } = await loaded()
    const reply = deferred<unknown>()
    guest.executeJavaScript.mockReturnValue(reply.promise)
    const capture = h.page.capture(kind, { maxBytes: 4096 })
    if (change === 'reload') h.page.reload()
    else if (change === 'navigation') { guest.state.url = 'https://next.test/'; guest.emit('did-navigate') }
    else if (change === 'same-url-navigation') guest.emit('did-start-navigation', { isMainFrame: true })
    else if (change === 'replacement') h.mount()
    else await h.page.dispose()
    reply.resolve({ text: 'Stale selected text' })
    await expect(capture).rejects.toMatchObject({ code: change === 'closed' ? 'closed' : 'changed' })
  })

  it('releases a reservation that arrives after tab closure and waits for acquisition teardown', async () => {
    const h = fixture()
    fixtures.push(h)
    const reserved = deferred<typeof h.reservation>()
    h.bridge.acquire.mockReturnValue(reserved.promise)
    h.mount()
    h.page.loadUrl(URL)
    await vi.waitFor(() => { expect(h.bridge.acquire).toHaveBeenCalledOnce() })
    const disposed = h.page.dispose()
    reserved.resolve(h.reservation)
    await disposed
    expect(h.bridge.release).toHaveBeenCalledExactlyOnceWith(h.reservation.lease)
    expect(h.host.querySelector('webview')).toBeNull()
  })

  it('contains native release failures before a page can be reused or detached promises escape', async () => {
    const { h } = await loaded()
    const failure = new Error('Native guest release unavailable')
    h.bridge.release.mockRejectedValue(failure)
    const report = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(h.page.dispose()).resolves.toBeUndefined()
    await expect(h.page.dispose()).resolves.toBeUndefined()
    expect(report).toHaveBeenCalledWith('Reference browser guest release failed', failure)
    expect(h.bridge.release).toHaveBeenCalledOnce()
    expect(h.host.childElementCount).toBe(0)
    await expect(h.page.capture('selection', { maxBytes: 4096 })).rejects.toMatchObject({ code: 'closed' })
  })

  it('keeps plain Web unsupported and rejects forbidden addresses before acquiring guests', async () => {
    const host = document.createElement('div')
    host.id = 'web-only-owned-page'
    document.body.append(host)
    const page = new NativePage(undefined, async () => 'cwd:/canonical', 'https://app.test')
    page.mount(host.id, new AbortController().signal, URL, vi.fn())
    expect(page.getSnapshot()).toMatchObject({ available: false, error: 'desktop-only' })
    await expect(page.capture('selection', { maxBytes: 4096 })).rejects.toMatchObject({ code: 'unsupported' })
    await page.dispose()
    expect(browserBridge()).toBeUndefined()
    const h = fixture()
    fixtures.push(h)
    h.mount()
    for (const url of ['javascript:alert(1)', 'file:///tmp/a', 'https://user:secret@example.test/', 'https://app.test/']) h.page.loadUrl(url)
    expect(h.page.getSnapshot().error).toBe('invalid-address')
    expect(h.bridge.acquire).not.toHaveBeenCalled()
  })

  it('resolves exactly the stock CWD key and waits for an authoritative Workspace list', async () => {
    const sessionId = 'session' as SessionId
    const pending: WorkspaceSnapshot = { phase: 'pending', items: [], state: 'idle', error: null,
      archivedSessionIds: [], pinnedSessionIds: [] }
    const source = createSnapshotStore(pending)
    const lifetime = new AbortController()
    const key = workspaceKey(source, sessionId, lifetime.signal)
    source.set({ ...pending, phase: 'ready', items: [{ workspaceId: 'workspace' as WorkspaceId, path: 'E:\\Canonical',
      title: 'Work', sessionIds: [sessionId], createdAt: '', updatedAt: '' }] })
    await expect(key).resolves.toBe('cwd:E:\\Canonical')
    await expect(workspaceKey(source, 'ungrouped', lifetime.signal)).resolves.toBe('session:ungrouped')
  })
})
