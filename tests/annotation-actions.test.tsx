import React, { useSyncExternalStore } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BrowserActions, type Props } from '../src/client/Actions.tsx'
import { createRecoveryStore } from '../src/client/store.ts'
import { ReferenceError } from '../src/client/reference.ts'
import { zh } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Menu: ({ open, anchor, children }: { open: boolean; anchor: React.ReactNode; children: React.ReactNode }) => <>{anchor}{open && <div role="menu">{children}</div>}</>,
  MenuItemButton: ({ children, disabled, onSelect }: { children: React.ReactNode; disabled: boolean; onSelect(): void }) => <button role="menuitem" disabled={disabled} onClick={onSelect}>{children}</button>,
}))
// This suite owns action-to-editor handoff; drawing and real canvas composition have their own tests.
vi.mock('../src/client/AnnotationEditor.tsx', () => ({ AnnotationEditor: ({ onSave, onCancel, changed, labels, element }: {
  onSave(result: { bytes: Uint8Array; comment: string; markCount: number }): void; onCancel(): void; changed: boolean;
  labels: { title: string; save: string; cancel: string }; element?: { selector: string }
}) => <div role="dialog" aria-label={labels.title}>
  {element !== undefined && <span>{element.selector}</span>}
  <button disabled={changed} onClick={() => onSave({ bytes: new Uint8Array([137,80,78,71,1]), comment: '这里请调整', markCount: 2 })}>{labels.save}</button>
  <button onClick={onCancel}>{labels.cancel}</button>
</div> }))
afterEach(cleanup)
const image = { kind: 'viewport' as const, url: 'https://example.com/page', title: 'Page', mimeType: 'image/png' as const, bytes: new Uint8Array([137,80,78,71]) }
const element = { tag: 'button', selector: 'html:nth-of-type(1) > body:nth-of-type(1) > button:nth-of-type(1)', role: 'button', label: 'Read', text: 'Read',
  rect: { x: 10, y: 20, width: 50, height: 30 }, viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0 } }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const store = createRecoveryStore().create('one')
  const inputActions = { captureInsertion: vi.fn(() => ({ start: 1, end: 3, draftRev: 4 })), insertText: vi.fn(), setDraft: vi.fn(), persistDraft: vi.fn(), addAttachments: vi.fn(), removeAttachment: vi.fn(), pruneAttachments: vi.fn(), submit: vi.fn() }
  const commit = vi.fn()
  const props = { available: true, source: { tabId: 'tab', url: image.url, title: image.title, generation: 1 },
    capture: vi.fn(async () => image), pickElement: vi.fn(async () => ({ image, element })), sessionId: 'one', inputActions,
    useStore: (select: (state: ReturnType<typeof store.getSnapshot>) => unknown) => select(useSyncExternalStore(store.subscribe, store.getSnapshot)),
    actions: store.actions, t: (key: keyof typeof zh) => zh[key],
    useConfig: select => select({ status: 'ready', value: { maxTextBytes: 65536, maxImageBytes: 10485760, subtitleRequestTimeoutMs: 15000 } }),
    readLimits: vi.fn(() => ({ maxTextBytes: 65536, maxImageBytes: 10485760 })), commit } as Props
  return { props, store, commit, inputActions }
}
function choose(label: string) { fireEvent.click(screen.getByRole('button', { name: zh.quote })); fireEvent.click(screen.getByRole('menuitem', { name: label })) }

describe('explicit screenshot and element annotation handoff', () => {
  it('does not let an old cancelled picker clear a newer pending operation', async () => {
    const f = fixture(); const first = deferred<{ image: typeof image; element: typeof element }>(); const second = deferred<{ image: typeof image; element: typeof element }>()
    vi.mocked(f.props.pickElement!).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    render(<BrowserActions {...f.props} />); choose(zh.pickAnnotate)
    fireEvent.click(screen.getByRole('button', { name: zh.cancelPick })); choose(zh.pickAnnotate)
    await act(async () => first.resolve({ image, element }))
    expect(screen.getByRole('button', { name: zh.cancelPick })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.quote }).hasAttribute('disabled')).toBe(true)
    await act(async () => second.resolve({ image, element })); expect(screen.getByRole('dialog')).toBeTruthy()
  })
  it('retains a completed old-page screenshot if navigation wins before editing begins', async () => {
    const f = fixture(); const pending = deferred<typeof image>(); vi.mocked(f.props.capture).mockReturnValueOnce(pending.promise)
    const ui = render(<BrowserActions {...f.props} />); choose(zh.annotate)
    ui.rerender(<BrowserActions {...f.props} source={{ ...f.props.source!, generation: 2, url: 'https://example.com/next' }} />)
    await act(async () => pending.resolve(image))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.store.getSnapshot().recovery?.capture).toEqual(image)
    expect(f.store.getSnapshot().notice).toBe('changed'); expect(f.commit).not.toHaveBeenCalled()
  })
  it('opens a frozen screenshot without changing the draft, then admits only on explicit save', async () => {
    const f = fixture(); render(<BrowserActions {...f.props} />); choose(zh.annotate)
    await screen.findByRole('dialog')
    expect(f.props.capture).toHaveBeenCalledExactlyOnceWith('viewport', { maxBytes: 10485760 })
    expect(f.commit).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: zh.annotationSave }))
    expect(f.commit).toHaveBeenCalledTimes(1)
    expect(f.commit.mock.calls[0]![0].capture).toMatchObject({ kind: 'annotation', comment: '这里请调整', markCount: 2 })
    expect(f.commit.mock.calls[0]![2]).toEqual({ start: 3, end: 3, draftRev: 4 })
    expect(f.inputActions.submit).not.toHaveBeenCalled(); expect(f.inputActions.setDraft).not.toHaveBeenCalled()
  })
  it('uses the owned picker and includes its bounded element hints without recapturing', async () => {
    const f = fixture(); render(<BrowserActions {...f.props} />); choose(zh.pickAnnotate)
    await screen.findByRole('dialog'); expect(screen.getByText(element.selector)).toBeTruthy()
    expect(f.props.capture).not.toHaveBeenCalled(); expect(f.props.pickElement).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: zh.annotationSave }))
    expect(f.commit.mock.calls[0]![0].capture.element).toEqual(element)
    expect(f.commit.mock.calls[0]![0].source).toContain('not a verified source-code location')
  })
  it('cancels editing without a draft mutation', async () => {
    const f = fixture(); render(<BrowserActions {...f.props} />); choose(zh.annotate)
    await screen.findByRole('dialog'); fireEvent.click(screen.getByRole('button', { name: zh.annotationCancel }))
    expect(screen.queryByRole('dialog')).toBeNull(); expect(f.commit).not.toHaveBeenCalled()
  })
  it('aborts picking and ignores a later result', async () => {
    const f = fixture(); const pending = deferred<{ image: typeof image; element: typeof element }>()
    vi.mocked(f.props.pickElement!).mockReturnValueOnce(pending.promise)
    render(<BrowserActions {...f.props} />); choose(zh.pickAnnotate)
    fireEvent.click(screen.getByRole('button', { name: zh.cancelPick }))
    expect(vi.mocked(f.props.pickElement!).mock.calls[0]![1].aborted).toBe(true)
    await act(async () => pending.resolve({ image, element }))
    expect(screen.queryByRole('dialog')).toBeNull(); expect(f.commit).not.toHaveBeenCalled()
  })
  it('treats Escape cancellation as no operation, not a capture failure', async () => {
    const f = fixture(); vi.mocked(f.props.pickElement!).mockRejectedValueOnce(Object.assign(new Error('cancelled'), { code: 'cancelled' }))
    render(<BrowserActions {...f.props} />); choose(zh.pickAnnotate)
    await waitFor(() => expect(screen.getByRole('button', { name: zh.quote }).hasAttribute('disabled')).toBe(false))
    expect(f.store.getSnapshot().notice).toBeUndefined(); expect(f.commit).not.toHaveBeenCalled()
  })
  it('disables saving stale-page annotations but leaves the editor visible', async () => {
    const f = fixture(); const ui = render(<BrowserActions {...f.props} />); choose(zh.annotate)
    await screen.findByRole('dialog')
    ui.rerender(<BrowserActions {...f.props} source={{ ...f.props.source!, generation: 2 }} />)
    expect(screen.getByRole('button', { name: zh.annotationSave }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('dialog')).toBeTruthy(); expect(f.commit).not.toHaveBeenCalled()
  })
  it('does not open an editor after a session switch and return', async () => {
    const f = fixture(); const pending = deferred<typeof image>(); vi.mocked(f.props.capture).mockReturnValueOnce(pending.promise)
    const ui = render(<BrowserActions {...f.props} />); choose(zh.annotate)
    ui.rerender(<BrowserActions {...f.props} sessionId={'two' as Props['sessionId']} />); ui.rerender(<BrowserActions {...f.props} />)
    await act(async () => pending.resolve(image)); expect(screen.queryByRole('dialog')).toBeNull(); expect(f.commit).not.toHaveBeenCalled()
  })
  it('retains the composited PNG and comment if native draft admission rejects', async () => {
    const f = fixture(); f.commit.mockImplementationOnce(() => { throw new ReferenceError('changed') })
    render(<BrowserActions {...f.props} />); choose(zh.annotate); await screen.findByRole('dialog')
    fireEvent.click(screen.getByRole('button', { name: zh.annotationSave }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(f.store.getSnapshot().recovery?.capture).toMatchObject({ kind: 'annotation', comment: '这里请调整' })
    expect(screen.getByRole('img', { name: zh.preview })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: zh.retry }))
    expect(f.commit).toHaveBeenCalledTimes(2); expect(f.props.capture).toHaveBeenCalledTimes(1)
  })
})
