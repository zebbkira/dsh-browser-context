import React, { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserActions } from '../src/client/Actions.tsx'
import type { Props } from '../src/client/Actions.tsx'
import { createRecoveryStore } from '../src/client/store.ts'
import { ReferenceError } from '../src/client/reference.ts'
import { zh } from '../src/client/locales.ts'
import type { InputState } from '@deepseek-ai/dsh-client-ui-conversation/client'

// Keep business component tests independent of Menu's placement and animation machinery.
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Tooltip: ({ children, label }: { children: React.ReactNode; label: string }) => <span title={label}>{children}</span>,
  Menu: ({ open, anchor, children, onClose }: { open: boolean; anchor: React.ReactNode; children: React.ReactNode; onClose(): void }) => <>{anchor}{open && <div role="menu" onKeyDown={e => { if (e.key === 'Escape') onClose() }}>{children}</div>}</>,
  MenuItemButton: ({ children, disabled, onSelect }: { children: React.ReactNode; disabled: boolean; onSelect(): void }) => <button role="menuitem" disabled={disabled} onClick={onSelect}>{children}</button>,
}))
afterEach(cleanup)
const selected = { kind: 'selection' as const, url: 'https://example.com/', title: 'Page', text: 'quote' }
const partialVideo = { kind: 'video' as const, url: 'https://www.bilibili.com/video/BV1xx411c7mD/', title: 'Video page',
  text: 'Page information only', format: 'text' as const, coverage: 'loaded' as const,
  subtitleStatus: 'not-loaded' as const, subtitleReason: 'request-failed' as const }
const png = { kind: 'viewport' as const, url: selected.url, title: 'Screenshot', mimeType: 'image/png' as const, bytes: new Uint8Array([137,80,78,71]) }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((a,b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture() {
  const store = createRecoveryStore().create('one')
  let input = { draft: 'draft', draftRev: 4, attachmentIds: [], phase: 'plain', occurrences: [], queue: [] } as InputState
  const inputActions = { captureInsertion: vi.fn(() => ({ start: input.draft.length, end: input.draft.length, draftRev: input.draftRev })),  insertText: vi.fn(), setDraft: vi.fn(), persistDraft: vi.fn(), addAttachments: vi.fn(), removeAttachment: vi.fn(), pruneAttachments: vi.fn(), submit: vi.fn() }
  const commit = vi.fn()
  const props = {
    available: true, source: { tabId: 'tab-one', url: selected.url, title: selected.title, generation: 1 },
    capture: vi.fn(async () => selected), sessionId: 'one', inputActions,
    useInput: (selector: (value: InputState) => unknown) => selector(input),
    useStore: (selector: (value: ReturnType<typeof store.getSnapshot>) => unknown) => selector(useSyncExternalStore(store.subscribe, store.getSnapshot)),
    actions: store.actions, t: (key: keyof typeof zh) => zh[key],
    useConfig: (selector) => selector({ status: 'ready', value: { maxTextBytes: 65536, maxImageBytes: 10485760, subtitleRequestTimeoutMs: 15000 } }),
    readLimits: vi.fn(() => ({ maxTextBytes: 65536, maxImageBytes: 10485760, subtitleRequestTimeoutMs: 15000 })), commit,
  } as Props
  return { props, commit, inputActions, store, edit: () => { input = { ...input, draft: 'new draft', draftRev: 5 } } }
}
function choose(label: string) {
  fireEvent.click(screen.getByRole('button', { name: zh.quote }))
  fireEvent.click(screen.getByRole('menuitem', { name: label }))
}

describe('Browser reference menu', () => {
  it('offers the same article action for a local HTML file without requiring a selection', async () => {
    const f = fixture()
    const localFile = { path: 'E:/demo/index.html', resourceAddress: 'dsh-resource://file/session/one/E:/demo/index.html', version: 'local-v1' }
    const source = { ...f.props.source!, url: localFile.resourceAddress, localFile }
    vi.mocked(f.props.capture).mockResolvedValueOnce({ kind: 'article', url: source.url, title: 'Local article',
      text: '# 本地正文\n\n不需要预先选中文字。', format: 'markdown', localFile })
    render(<BrowserActions {...f.props} source={source} />); choose(zh.article)
    await waitFor(() => expect(f.commit).toHaveBeenCalledTimes(1))
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('article', { maxBytes: 65536 })
    expect(f.commit.mock.calls[0]![0].capture).toMatchObject({ kind: 'article', format: 'markdown', localFile })
    expect(f.commit.mock.calls[0]![0].source).toContain('Local HTML file snapshot')
    expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it('freezes the native selection end rather than replacing selected draft text', async () => {
    const f = fixture(); const pending = deferred<typeof selected>()
    f.inputActions.captureInsertion.mockReturnValue({ start: 1, end: 3, draftRev: 4 })
    vi.mocked(f.props.capture).mockReturnValueOnce(pending.promise)
    render(<BrowserActions {...f.props} />); choose(zh.selection)
    f.inputActions.captureInsertion.mockReturnValue({ start: 8, end: 8, draftRev: 4 })
    await act(async () => pending.resolve(selected))
    expect(f.commit.mock.calls[0]![2]).toEqual({ start: 3, end: 3, draftRev: 4 })
    expect(f.inputActions.setDraft).not.toHaveBeenCalled()
  })
  it('retains the complete source and shows a clear host-upgrade notice when native quotes are unavailable', async () => {
    const f = fixture()
    f.commit.mockImplementationOnce(() => { throw new ReferenceError('quoteUnavailable') })
    render(<BrowserActions {...f.props} />); choose(zh.selection)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.quoteUnavailable))
    expect(screen.getByRole('textbox', { name: zh.source }).textContent).toContain('> quote')
    expect(f.inputActions.insertText).not.toHaveBeenCalled()
    expect(f.inputActions.setDraft).not.toHaveBeenCalled()
    expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it('keeps the starting Host-form limits during capture, and uses current limits only for explicit re-add', async () => {
    const f = fixture(); const pending = deferred<typeof selected>()
    vi.mocked(f.props.capture).mockReturnValueOnce(pending.promise)
    f.commit.mockImplementationOnce(() => { throw new ReferenceError('changed') })
    render(<BrowserActions {...f.props} />); choose(zh.selection)
    vi.mocked(f.props.readLimits).mockReturnValue({ maxTextBytes: 1024, maxImageBytes: 2048 })
    await act(async () => pending.resolve(selected))
    expect(f.commit.mock.calls[0]![3]).toEqual({ maxTextBytes: 65536, maxImageBytes: 10485760, subtitleRequestTimeoutMs: 15000 })
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(f.commit.mock.calls[1]![3]).toEqual({ maxTextBytes: 1024, maxImageBytes: 2048 })
    expect(f.props.capture).toHaveBeenCalledTimes(1)
  })
  it('mounts without any client Config argument and blocks capture until the authoritative form is ready', () => {
    const f = fixture()
    render(<BrowserActions {...f.props} useConfig={selector => selector({ status: 'loading', value: undefined, base: {}, user: {}, revision: undefined, writable: false })} />)
    expect(screen.getByRole('button', { name: zh.quote }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText(zh.config)).toBeTruthy()
    expect(f.props.capture).not.toHaveBeenCalled()
  })
  it('does not capture on mount; displays only explicit selection and screenshot choices', async () => {
    const f = fixture(); render(<BrowserActions {...f.props} />)
    expect(f.props.capture).not.toHaveBeenCalled()
    choose(zh.selection)
    await waitFor(() => expect(f.commit).toHaveBeenCalledTimes(1))
    expect(f.props.capture).toHaveBeenCalledWith('selection', { maxBytes: 65536 })
    expect(f.commit.mock.calls[0]![2]).toEqual({ start: 5, end: 5, draftRev: 4 })
    expect(f.inputActions.setDraft).not.toHaveBeenCalled(); expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it('keeps an edited draft untouched and exposes retained source for explicit re-add', async () => {
    const f = fixture(); const pending = deferred<typeof selected>()
    vi.mocked(f.props.capture).mockReturnValueOnce(pending.promise)
    f.commit.mockImplementationOnce(() => { throw new ReferenceError('changed') })
    const ui = render(<BrowserActions {...f.props} />); choose(zh.selection)
    f.edit(); ui.rerender(<BrowserActions {...f.props} />)
    await act(async () => pending.resolve(selected))
    expect(screen.getByRole('status').textContent).toBe(zh.changed)
    expect(screen.getByRole('textbox', { name: zh.source }).getAttribute('readonly')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(f.commit).toHaveBeenCalledTimes(2)
    expect(f.commit.mock.calls[1]![2]).toEqual({ start: 9, end: 9, draftRev: 5 })
    expect(f.props.capture).toHaveBeenCalledTimes(1)
  })
  it('does not apply a late result after switching sessions, even after returning', async () => {
    const f = fixture(); const pending = deferred<typeof selected>()
    vi.mocked(f.props.capture).mockReturnValueOnce(pending.promise)
    const ui = render(<BrowserActions {...f.props} />); choose(zh.selection)
    ui.rerender(<BrowserActions {...f.props} sessionId={'two' as Props['sessionId']} />)
    ui.rerender(<BrowserActions {...f.props} />)
    await act(async () => pending.resolve(selected))
    expect(f.commit).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: zh.quote }).hasAttribute('disabled')).toBe(false)
  })
  it('does not mutate after unmount or auto-retry owner navigation failures', async () => {
    const f = fixture(); const pending = deferred<typeof selected>()
    vi.mocked(f.props.capture).mockReturnValueOnce(pending.promise)
    const ui = render(<BrowserActions {...f.props} />); choose(zh.selection); ui.unmount()
    await act(async () => pending.resolve(selected)); expect(f.commit).not.toHaveBeenCalled()
    render(<BrowserActions {...f.props} />)
    vi.mocked(f.props.capture).mockRejectedValueOnce(Object.assign(new Error('navigation'), { code: 'changed' }))
    choose(zh.selection)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.changed))
    expect(f.props.capture).toHaveBeenCalledTimes(2)
  })
  it('retains a real PNG preview after failed native admission and re-adds without recapture', async () => {
    const f = fixture(); vi.mocked(f.props.capture).mockResolvedValueOnce(png)
    f.commit.mockImplementationOnce(() => { throw new ReferenceError('attachment') })
    render(<BrowserActions {...f.props} />); choose(zh.viewport)
    await waitFor(() => expect(screen.getByRole('img').getAttribute('src')).toBe('data:image/png;base64,iVBORw=='))
    expect(screen.getByRole('status').textContent).toBe(zh.attachment)
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(f.commit).toHaveBeenCalledTimes(2); expect(f.props.capture).toHaveBeenCalledTimes(1)
  })
  it('offers ordinary input after empty selection and adds only on the explicit gesture', async () => {
    const f = fixture()
    vi.mocked(f.props.capture).mockRejectedValueOnce(Object.assign(new Error('empty'), { code: 'empty-selection' }))
    render(<BrowserActions {...f.props} />); choose(zh.selection)
    const field = await screen.findByRole('textbox', { name: zh.pasteInput })
    expect(f.commit).not.toHaveBeenCalled()
    fireEvent.change(field, { target: { value: '亲自粘贴\n# selected text' } })
    expect(f.commit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.pasteAdd }))
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ capture: {
      kind: 'pasted-selection', contextUrl: selected.url, contextTitle: selected.title,
      sourceVerified: false, text: '亲自粘贴\n# selected text',
    } }), f.inputActions, { start: 5, end: 5, draftRev: 4 }, expect.anything())
    expect(f.props.capture).toHaveBeenCalledTimes(1)
  })
  it('opens direct paste without capture or clipboard access and retains text across close/reopen', () => {
    const read = vi.fn(() => { throw new Error('Clipboard API must not be read') })
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: read })
    try {
      const f = fixture(); render(<BrowserActions {...f.props} />); choose(zh.paste)
      fireEvent.change(screen.getByRole('textbox', { name: zh.pasteInput }), { target: { value: 'manual text' } })
      const field = screen.getByRole('textbox', { name: zh.pasteInput })
      expect(fireEvent.keyDown(field, { key: 'v', ctrlKey: true })).toBe(true)
      expect(fireEvent.keyDown(field, { key: 'ArrowDown' })).toBe(true)
      expect(fireEvent.keyDown(field, { key: 'Home' })).toBe(true)
      fireEvent.keyDown(field, { key: 'Escape' })
      expect(screen.queryByRole('menu')).toBeNull()
      fireEvent.click(screen.getByRole('button', { name: zh.quote }))
      expect(screen.getByRole('textbox', { name: zh.pasteInput }).getAttribute('readonly')).toBeNull()
      expect((screen.getByRole('textbox', { name: zh.pasteInput }) as HTMLTextAreaElement).value).toBe('manual text')
      expect(read).not.toHaveBeenCalled(); expect(f.props.capture).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original)
      else Reflect.deleteProperty(navigator, 'clipboard')
    }
  })
  it('blocks paste after page generation changes, including returning to the same URL', () => {
    const f = fixture(); const ui = render(<BrowserActions {...f.props} />); choose(zh.paste)
    fireEvent.change(screen.getByRole('textbox', { name: zh.pasteInput }), { target: { value: 'retained' } })
    ui.rerender(<BrowserActions {...f.props} source={{ ...f.props.source!, generation: 3 }} />)
    expect(screen.getByText(zh.pasteChanged)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.pasteAdd }))
    expect(f.commit).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox', { name: zh.pasteInput }) as HTMLTextAreaElement).value).toBe('retained')
  })
  it('blocks a different tab with identical URL, title and generation', () => {
    const f = fixture(); const ui = render(<BrowserActions {...f.props} />); choose(zh.paste)
    fireEvent.change(screen.getByRole('textbox', { name: zh.pasteInput }), { target: { value: 'tab one text' } })
    ui.rerender(<BrowserActions {...f.props} source={{ ...f.props.source!, tabId: 'tab-two' as NonNullable<Props['source']>['tabId'] }} />)
    expect(screen.getByText(zh.pasteChanged)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.pasteAdd }))
    expect(f.commit).not.toHaveBeenCalled()
    expect((screen.getByRole('textbox', { name: zh.pasteInput }) as HTMLTextAreaElement).value).toBe('tab one text')
  })
  it('never applies waiting paste to another session and preserves its starting draft CAS', () => {
    const f = fixture(); const ui = render(<BrowserActions {...f.props} />); choose(zh.paste)
    fireEvent.change(screen.getByRole('textbox', { name: zh.pasteInput }), { target: { value: 'retained' } })
    ui.rerender(<BrowserActions {...f.props} sessionId={'two' as Props['sessionId']} />)
    expect(screen.queryByRole('button', { name: zh.pasteAdd })).toBeNull()
    ui.rerender(<BrowserActions {...f.props} />)
    f.edit(); ui.rerender(<BrowserActions {...f.props} />)
    f.commit.mockImplementationOnce(() => { throw new ReferenceError('changed') })
    fireEvent.click(screen.getByRole('button', { name: zh.pasteAdd }))
    expect(f.commit.mock.calls[0]![2]).toEqual({ start: 5, end: 5, draftRev: 4 })
    expect((screen.getByRole('textbox', { name: zh.pasteInput }) as HTMLTextAreaElement).value).toBe('retained')
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(f.commit.mock.calls[1]![2]).toEqual({ start: 9, end: 9, draftRev: 5 })
    expect(f.inputActions.setDraft).not.toHaveBeenCalled()
  })
  it('reads a WeCom selection only after clicking its dedicated menu item', async () => {
    const f = fixture()
    const captured = { kind: 'selection' as const, url: 'https://doc.weixin.qq.com/doc/fixture?scode=hidden',
      title: 'WeCom selection', text: '用户实际选择的片段\n第二行' }
    vi.mocked(f.props.capture).mockResolvedValueOnce(captured)
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: captured.url }} />)
    expect(f.props.capture).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.quote }))
    expect(f.props.capture).not.toHaveBeenCalled()
    expect(screen.getAllByRole('menuitem')).toHaveLength(6)
    expect(screen.queryByRole('menuitem', { name: zh.selection })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: zh.wecomSelection }))
    await waitFor(() => expect(f.commit).toHaveBeenCalledTimes(1))
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('selection', { maxBytes: 65536 })
    const reference = f.commit.mock.calls[0]![0]
    const header = JSON.parse(reference.source.split('\n')[1])
    expect(header).toMatchObject({ kind: 'selection', url: 'https://doc.weixin.qq.com/doc/fixture' })
    expect(header).not.toHaveProperty('coverage')
    expect(reference.source).toContain('> 用户实际选择的片段\n> 第二行')
    expect(reference.source).not.toContain('scode=')
    expect(f.inputActions.setDraft).not.toHaveBeenCalled(); expect(f.inputActions.submit).not.toHaveBeenCalled()
    expect(f.store.getSnapshot().paste).toBeUndefined()
  })
  it.each([
    ['copy-denied', 'copyDenied'], ['melo-unavailable', 'wecomSelectionUnavailable'], ['melo-range-unavailable', 'wecomRangeUnavailable'],
  ] as const)('shows %s without inserting, opening paste automatically or substituting another capture', async (code, notice) => {
    const f = fixture()
    vi.mocked(f.props.capture).mockRejectedValueOnce(Object.assign(new Error('fixed reader failure'), { code }))
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: 'https://doc.weixin.qq.com/doc/fixture' }} />)
    choose(zh.wecomSelection)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh[notice]))
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('selection', { maxBytes: 65536 })
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.store.getSnapshot().recovery).toBeUndefined(); expect(f.store.getSnapshot().paste).toBeUndefined()
    expect(screen.queryByRole('textbox', { name: zh.pasteInput })).toBeNull()
    expect(f.inputActions.insertText).not.toHaveBeenCalled(); expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it('keeps range-shape failure distinct and exposes only validated diagnostics for manual inspection', async () => {
    const f = fixture()
    const info = { kind: 'array', members: [{ name: 'length', type: 'number', depth: 0 }], truncated: false,
      firstItem: { members: [{ name: 'begin', type: 'function', depth: 1 }], truncated: false } }
    const cause = new Error(`Melo selection stage: selection\nselectionInfo: ${JSON.stringify(info)}`)
    vi.mocked(f.props.capture).mockRejectedValueOnce(Object.assign(new Error('range conversion unavailable'), { code: 'melo-range-unavailable', cause }))
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: 'https://doc.weixin.qq.com/doc/fixture' }} />)
    choose(zh.wecomSelection)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.wecomRangeUnavailable))
    expect(screen.queryByText(zh.wecomSelectionUnavailable)).toBeNull()
    expect(screen.queryByText(zh.copyDenied)).toBeNull()
    const details = screen.getByLabelText(zh.detailsCopy) as HTMLTextAreaElement
    expect(details.readOnly).toBe(true)
    expect(details.value).toContain('selectionInfo:')
    expect(details.value).toContain('begin')
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.store.getSnapshot().paste).toBeUndefined(); expect(f.store.getSnapshot().recovery).toBeUndefined()
    expect(screen.queryByRole('textbox', { name: zh.pasteInput })).toBeNull()
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('selection', { maxBytes: 65536 })
    expect(f.inputActions.insertText).not.toHaveBeenCalled(); expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it('asks for a real WeCom selection instead of automatically opening a paste draft on empty', async () => {
    const f = fixture()
    vi.mocked(f.props.capture).mockRejectedValueOnce(Object.assign(new Error('fixed empty selection'), { code: 'empty-selection' }))
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: 'https://doc.weixin.qq.com/doc/fixture' }} />)
    choose(zh.wecomSelection)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.wecomEmpty))
    expect(f.commit).not.toHaveBeenCalled(); expect(f.store.getSnapshot().paste).toBeUndefined()
    expect(screen.queryByRole('textbox', { name: zh.pasteInput })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: zh.paste }))
    expect(screen.getByRole('textbox', { name: zh.pasteInput })).toBeTruthy()
    expect(f.props.capture).toHaveBeenCalledTimes(1)
    expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it.each(['loaded', 'not-loaded'] as const)('explicitly captures Bilibili page information and %s subtitles from the existing second menu row', async subtitleStatus => {
    const f = fixture()
    const video = { kind: 'video' as const, url: 'https://www.bilibili.com/video/BV1xx411c7mD/?p=1&access_token=hidden',
      title: '视频页面', text: subtitleStatus === 'loaded' ? '视频信息\n00:01 已加载字幕' : '视频信息',
      format: 'text' as const, coverage: 'loaded' as const, subtitleStatus }
    vi.mocked(f.props.capture).mockResolvedValueOnce(video)
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: video.url }} />)
    expect(f.props.capture).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.quote }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(6)
    expect(screen.queryByRole('menuitem', { name: zh.article })).toBeNull()
    expect(f.props.capture).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('menuitem', { name: zh.video }))
    await waitFor(() => expect(f.commit).toHaveBeenCalledTimes(1))
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('video', { maxBytes: 65536, subtitleRequestTimeoutMs: 15000 })
    const reference = f.commit.mock.calls[0]![0]
    expect(JSON.parse(reference.source.split('\n')[1])).toMatchObject({ kind: 'video', format: 'text', coverage: 'loaded', subtitleStatus })
    expect(reference.source).toContain('Video page information and subtitles only — sources: existing standard cues or normal site subtitle requests; audio/images not analyzed; subtitle completeness not verified')
    expect(reference.source).not.toContain('access_token=')
    if (subtitleStatus === 'not-loaded') {
      expect(reference.source).toContain('[No subtitles captured]')
      expect(screen.getByRole('status').textContent).toBe(zh.videoAddedNoSubtitles)
    } else expect(f.store.getSnapshot().notice).toBe('added')
    expect(screen.queryByLabelText(zh.detailsCopy)).toBeNull()
    expect(f.store.getSnapshot().paste).toBeUndefined()
    expect(f.inputActions.setDraft).not.toHaveBeenCalled(); expect(f.inputActions.submit).not.toHaveBeenCalled()
    expect(f.inputActions.insertText).not.toHaveBeenCalled()
  })
  it.each([
    ['not-available', 'videoAddedIdentityUnavailable'], ['not-provided', 'videoAddedSubtitleUnavailable'],
    ['login-required', 'videoAddedLoginRequired'], ['access-denied', 'videoAddedAccessDenied'],
    ['request-failed', 'videoAddedSubtitleRequestFailed'], ['timeout', 'videoAddedSubtitleTimeout'],
  ] as const)('reports %s subtitles as a partial result without automatic retries or capture substitution', async (subtitleReason, notice) => {
    const f = fixture()
    const video = { kind: 'video' as const, url: 'https://www.bilibili.com/video/BV1xx411c7mD/', title: 'Page information',
      text: 'Video title and description', format: 'text' as const, coverage: 'loaded' as const, subtitleStatus: 'not-loaded' as const, subtitleReason }
    vi.mocked(f.props.capture).mockResolvedValueOnce(video)
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: video.url }} />); choose(zh.video)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh[notice]))
    expect(f.commit).toHaveBeenCalledTimes(1)
    expect(JSON.parse(f.commit.mock.calls[0]![0].source.split('\n')[1])).toMatchObject({ subtitleReason, subtitleStatus: 'not-loaded' })
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('video', { maxBytes: 65536, subtitleRequestTimeoutMs: 15000 })
    expect(f.store.getSnapshot().paste).toBeUndefined()
    expect(f.inputActions.submit).not.toHaveBeenCalled(); expect(f.inputActions.setDraft).not.toHaveBeenCalled()
  })
  it.each([
    { stage: 'subtitle-info', failure: 'api', httpStatus: 200, apiCode: -400 },
    { stage: 'subtitle-file', failure: 'http', httpStatus: 500 },
    { stage: 'video-info', failure: 'network' },
  ] as const)('shows only safe $stage / $failure subtitle diagnostics after partial admission succeeds', async diagnostic => {
    const f = fixture()
    const subtitleDiagnostic = { ...diagnostic, signedUrl: 'https://sub.example.invalid/captions?auth_key=PRIVATE_SIGNED_URL',
      cookie: 'PRIVATE_COOKIE', headers: { authorization: 'PRIVATE_AUTH' }, rawErrorMessage: 'PRIVATE_RAW_MESSAGE' }
    vi.mocked(f.props.capture).mockResolvedValueOnce({ ...partialVideo, subtitleDiagnostic })
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: partialVideo.url }} />); choose(zh.video)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.videoAddedSubtitleRequestFailed))
    const details = screen.getByLabelText(zh.detailsCopy) as HTMLTextAreaElement
    expect(details.readOnly).toBe(true)
    expect(JSON.parse(details.value)).toEqual({ name: 'BilibiliSubtitleDiagnostic', ...diagnostic })
    expect(details.value).not.toContain('PRIVATE_')
    expect(details.value).not.toContain('auth_key'); expect(details.value).not.toContain('cookie')
    expect(f.commit).toHaveBeenCalledTimes(1)
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('video', { maxBytes: 65536, subtitleRequestTimeoutMs: 15000 })
    expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it('keeps quote-admission failure details instead of replacing them with subtitle diagnostics', async () => {
    const f = fixture()
    const subtitleDiagnostic = { stage: 'subtitle-info' as const, failure: 'api' as const, httpStatus: 200, apiCode: -400 }
    vi.mocked(f.props.capture).mockResolvedValueOnce({ ...partialVideo, subtitleDiagnostic })
    f.commit.mockImplementationOnce(() => { throw new ReferenceError('changed', { cause: new Error('admission failure marker') }) })
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: partialVideo.url }} />); choose(zh.video)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.changed))
    const details = screen.getByLabelText(zh.detailsCopy) as HTMLTextAreaElement
    expect(details.value).toContain('admission failure marker')
    expect(details.value).not.toContain('BilibiliSubtitleDiagnostic')
    expect(f.store.getSnapshot().recovery?.capture).toMatchObject({ subtitleDiagnostic })
    expect(f.props.capture).toHaveBeenCalledTimes(1)
    expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it.each(['session', 'input-actions'] as const)('ignores late subtitle diagnostics after a %s change', async changed => {
    const f = fixture(); const next = fixture()
    const result = { ...partialVideo, subtitleDiagnostic: { stage: 'subtitle-file' as const, failure: 'http' as const, httpStatus: 500 } }
    const pending = deferred<typeof result>()
    vi.mocked(f.props.capture).mockReturnValueOnce(pending.promise)
    const ui = render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: partialVideo.url }} />); choose(zh.video)
    ui.rerender(<BrowserActions {...f.props} sessionId={changed === 'session' ? 'other-session' as Props['sessionId'] : f.props.sessionId}
      inputActions={changed === 'input-actions' ? next.inputActions : f.inputActions} />)
    await act(async () => pending.resolve(result))
    expect(f.commit).not.toHaveBeenCalled()
    expect(screen.queryByLabelText(zh.detailsCopy)).toBeNull()
    expect(f.store.getSnapshot().recovery).toBeUndefined()
    expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it.each([undefined, 0, -1, 1.5, NaN, Infinity, 2147483648])('rejects missing or invalid video request timeout %s before capture', async subtitleRequestTimeoutMs => {
    const f = fixture()
    const budgets = { maxTextBytes: 65536, maxImageBytes: 10485760 }
    vi.mocked(f.props.readLimits).mockReturnValueOnce(subtitleRequestTimeoutMs === undefined ? budgets : { ...budgets, subtitleRequestTimeoutMs })
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: 'https://www.bilibili.com/video/BV1xx411c7mD/' }} />); choose(zh.video)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.subtitleConfig))
    const details = screen.getByLabelText(zh.detailsCopy) as HTMLTextAreaElement
    expect(details.value).toContain('BrowserContextConfigDiagnostic')
    expect(details.value).toContain('"field":"subtitleRequestTimeoutMs"')
    expect(details.value).toContain(`"reason":"${subtitleRequestTimeoutMs === undefined ? 'missing' : 'invalid'}"`)
    expect(f.props.capture).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
    expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it('passes the maximum valid timer duration explicitly instead of substituting a default', async () => {
    const f = fixture()
    vi.mocked(f.props.readLimits).mockReturnValueOnce({ maxTextBytes: 65536, maxImageBytes: 10485760, subtitleRequestTimeoutMs: 2147483647 })
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: 'https://www.bilibili.com/video/BV1xx411c7mD/' }} />); choose(zh.video)
    await waitFor(() => expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('video', { maxBytes: 65536, subtitleRequestTimeoutMs: 2147483647 }))
  })
  it('reports video-specific capture failure without substituting paste, screenshots or article extraction', async () => {
    const f = fixture()
    vi.mocked(f.props.capture).mockRejectedValueOnce(Object.assign(new Error('no video metadata'), { code: 'no-video' }))
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: 'https://www.bilibili.com/video/BV1xx411c7mD/' }} />)
    choose(zh.video)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.videoEmpty))
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('video', { maxBytes: 65536, subtitleRequestTimeoutMs: 15000 })
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.store.getSnapshot().paste).toBeUndefined(); expect(f.store.getSnapshot().recovery).toBeUndefined()
    expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it.each([
    ['https://www.bilibili.com/video/BV1xx411c7mD/', 'https://www.bilibili.com/video/BV1xx411c7mD/'],
    ['https://www.bilibili.com/video/BV1xx411c7mD/', selected.url],
    [selected.url, 'https://www.bilibili.com/video/BV1xx411c7mD/'],
  ])('rejects an article result for video context %s / %s', async (sourceUrl, returnedUrl) => {
    const f = fixture()
    vi.mocked(f.props.capture).mockResolvedValueOnce({ kind: 'article', url: returnedUrl, title: 'Page chrome', text: 'not video context', format: 'markdown' })
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: sourceUrl }} />)
    choose(sourceUrl === selected.url ? zh.article : zh.video)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.videoEmpty))
    expect(f.commit).not.toHaveBeenCalled(); expect(f.store.getSnapshot().recovery).toBeUndefined()
    expect(f.props.capture).toHaveBeenCalledTimes(1)
    expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it('keeps ordinary article Markdown capture and its complete text budget', async () => {
    const f = fixture()
    vi.mocked(f.props.capture).mockResolvedValueOnce({ kind: 'article', url: selected.url, title: 'Article', text: '# Body\n\nParagraph', format: 'markdown' })
    render(<BrowserActions {...f.props} />); choose(zh.article)
    await waitFor(() => expect(f.commit).toHaveBeenCalledTimes(1))
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('article', { maxBytes: 65536 })
    expect(f.commit.mock.calls[0]![0].source).toContain('> # Body\n> \n> Paragraph')
    expect(f.commit.mock.calls[0]![0].source).not.toContain('"coverage"')
  })
  it('uses the existing article menu row for explicit loaded-only WeCom document capture', async () => {
    const f = fixture()
    const document = { kind: 'document' as const, url: 'https://doc.weixin.qq.com/doc/example?scode=hidden',
      title: 'Loaded editor', text: '已加载第一段\n已加载第二段', format: 'text' as const, coverage: 'loaded' as const }
    vi.mocked(f.props.capture).mockResolvedValueOnce(document)
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: document.url }} />)
    fireEvent.click(screen.getByRole('button', { name: zh.quote }))
    expect(screen.getAllByRole('menuitem')).toHaveLength(6)
    expect(screen.queryByRole('menuitem', { name: zh.article })).toBeNull()
    fireEvent.click(screen.getByRole('menuitem', { name: zh.document }))
    await waitFor(() => expect(f.commit).toHaveBeenCalledTimes(1))
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('document', { maxBytes: 65536 })
    const reference = f.commit.mock.calls[0]![0]
    expect(reference.capture).toMatchObject({ kind: 'document', format: 'text', coverage: 'loaded' })
    expect(JSON.parse(reference.source.split('\n')[1])).toMatchObject({ kind: 'document', format: 'text', coverage: 'loaded', url: 'https://doc.weixin.qq.com/doc/example' })
    expect(reference.source).toContain('[Loaded document snapshot only — not verified complete; images and attachments are not included]')
    expect(reference.source).toContain('> 已加载第一段\n> 已加载第二段')
    expect(reference.source).not.toContain('scode=')
    expect(f.inputActions.setDraft).not.toHaveBeenCalled(); expect(f.inputActions.submit).not.toHaveBeenCalled()
  })
  it('explains an unreadable WeCom document distinctly without falling back to article or inserting toolbar text', async () => {
    const f = fixture()
    vi.mocked(f.props.capture).mockRejectedValueOnce(Object.assign(new Error('reader unavailable'), { code: 'no-document' }))
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url: 'https://doc.weixin.qq.com/doc/example' }} />)
    choose(zh.document)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.documentEmpty))
    expect(screen.queryByText(zh.articleEmpty)).toBeNull()
    expect(screen.queryByText(zh.articleUnavailable)).toBeNull()
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('document', { maxBytes: 65536 })
    expect(f.commit).not.toHaveBeenCalled(); expect(f.store.getSnapshot().recovery).toBeUndefined()
    expect(screen.getByRole('menuitem', { name: zh.paste })).toBeTruthy()
  })
  it('still rejects an article returned for a known WeCom document request', async () => {
    const f = fixture()
    const url = 'https://doc.weixin.qq.com/doc/example'
    vi.mocked(f.props.capture).mockResolvedValueOnce({ kind: 'article', url, title: 'Toolbar', text: 'menu toolbar', format: 'markdown' })
    render(<BrowserActions {...f.props} source={{ ...f.props.source!, url }} />); choose(zh.document)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.articleUnavailable))
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('document', { maxBytes: 65536 })
    expect(f.commit).not.toHaveBeenCalled(); expect(f.store.getSnapshot().recovery).toBeUndefined()
  })
  it('also refuses a cloud-document article result if owner context was not yet rendered', async () => {
    const f = fixture()
    vi.mocked(f.props.capture).mockResolvedValueOnce({ kind: 'article', url: 'https://doc.weixin.qq.com/doc/abc', title: 'Toolbar', text: 'menu toolbar', format: 'markdown' })
    render(<BrowserActions {...f.props} />); choose(zh.article)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.articleUnavailable))
    expect(f.commit).not.toHaveBeenCalled(); expect(f.store.getSnapshot().recovery).toBeUndefined()
  })
  it('explains unsupported capture and gives distinct empty-selection recovery guidance', async () => {
    const f = fixture(); const ui = render(<BrowserActions {...f.props} available={false} />)
    expect(screen.getByRole('button', { name: zh.quote }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByLabelText(zh.unavailable)).toBeTruthy()
    ui.rerender(<BrowserActions {...f.props} />)
    vi.mocked(f.props.capture).mockRejectedValueOnce(Object.assign(new Error('empty'), { code: 'empty-selection' }))
    choose(zh.selection)
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe(zh.empty))
    expect(screen.getByRole('textbox', { name: zh.pasteInput })).toBeTruthy()
  })
})
