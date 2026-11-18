// @vitest-environment jsdom
import React from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AnnotationEditor } from '../src/client/AnnotationEditor.tsx'
import type { AnnotationEditorLabels, AnnotationEditorProps } from '../src/client/AnnotationEditor.tsx'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, variant: _variant, size: _size, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: string; size?: string }) => <button {...props}>{children}</button>,
  Modal: ({ children, title, closeLabel, onClose }: { children: React.ReactNode; title: string; closeLabel: string; onClose(): void }) => <div role="dialog" aria-label={title} onKeyDown={event => { if (event.key === 'Escape') onClose() }}><button onClick={onClose}>{closeLabel}</button>{children}</div>,
}))

const labels: AnnotationEditorLabels = {
  title: 'Editor', close: 'Close', rectangle: 'Rectangle', ellipse: 'Circle', arrow: 'Arrow', pen: 'Pen',
  tools: 'Tools', undo: 'Undo', clear: 'Clear', comment: 'Comment', canvas: 'Screenshot', cancel: 'Cancel', save: 'Add',
  loading: 'Loading', saving: 'Saving', decodeError: 'Cannot decode', exportError: 'Cannot export',
  textLimit: 'Comment too large', imageLimit: 'Image too large', drawingLimit: 'Drawing too large', changed: 'Page changed; inspect only',
}
class TestImage {
  naturalWidth = 1000
  naturalHeight = 500
  src = ''
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() { images.push(this) }
}
let images: TestImage[]
let context: { clearRect: ReturnType<typeof vi.fn>; drawImage: ReturnType<typeof vi.fn>; rect: ReturnType<typeof vi.fn>; lineTo: ReturnType<typeof vi.fn>; [key: string]: unknown }
let encode: ReturnType<typeof vi.fn>
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
function blob(bytes = png): Blob {
  return { size: bytes.byteLength, type: 'image/png', arrayBuffer: async () => new Uint8Array(bytes).buffer } as Blob
}
function fixture(overrides: Partial<AnnotationEditorProps> = {}) {
  const props: AnnotationEditorProps = { image: { kind: 'viewport', url: 'https://example.com/', title: 'Page', mimeType: 'image/png', bytes: png },
    labels, maxTextBytes: 1024, maxImageBytes: 1024, onSave: vi.fn(), onCancel: vi.fn(), ...overrides }
  const view = render(<AnnotationEditor {...props} />)
  const target = screen.getByLabelText(labels.canvas) as HTMLCanvasElement
  target.setPointerCapture = vi.fn()
  target.releasePointerCapture = vi.fn()
  target.hasPointerCapture = vi.fn(() => true)
  vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({ x: 100, y: 50, width: 500, height: 250, top: 50, left: 100, right: 600, bottom: 300, toJSON() {} })
  return { props, view, target, decode: () => act(() => { images.at(-1)!.onload?.() }) }
}
function stroke(target: HTMLCanvasElement) {
  fireEvent.pointerDown(target, { pointerId: 7, button: 0, clientX: 120, clientY: 60 })
  fireEvent.pointerMove(target, { pointerId: 7, clientX: 200, clientY: 100 })
  fireEvent.pointerUp(target, { pointerId: 7, clientX: 250, clientY: 150 })
}
async function save() { await act(async () => { fireEvent.click(screen.getByRole('button', { name: labels.save })) }) }

beforeEach(() => {
  images = []
  vi.stubGlobal('Image', TestImage)
  vi.stubGlobal('PointerEvent', class extends MouseEvent {
    pointerId: number
    constructor(type: string, options: MouseEventInit & { pointerId?: number } = {}) { super(type, options); this.pointerId = options.pointerId ?? 0 }
  })
  context = { clearRect: vi.fn(), drawImage: vi.fn(), save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), ellipse: vi.fn(), stroke: vi.fn() }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => context as CanvasRenderingContext2D)
  encode = vi.fn((callback: BlobCallback) => callback(blob()))
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback, type) => { encode(callback, type) })
})
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('screenshot annotation editor', () => {
  it('uses caller labels, captures natural-pixel gestures, undoes and clears without changing input bytes', async () => {
    const f = fixture(); f.decode()
    expect(f.target.width).toBe(1000)
    expect(f.target.height).toBe(500)
    stroke(f.target)
    expect(f.target.setPointerCapture).toHaveBeenCalledWith(7)
    expect(context.rect).toHaveBeenCalledWith(40, 20, 260, 180)
    fireEvent.click(screen.getByRole('button', { name: labels.undo }))
    expect(screen.getByRole('button', { name: labels.undo }).hasAttribute('disabled')).toBe(true)
    stroke(f.target)
    fireEvent.click(screen.getByRole('button', { name: labels.clear }))
    fireEvent.change(screen.getByLabelText(labels.comment), { target: { value: '备注' } })
    await save()
    expect(encode).toHaveBeenCalledWith(expect.any(Function), 'image/png')
    expect(f.props.onSave).toHaveBeenCalledWith({ bytes: png, comment: '备注', markCount: 0 })
    expect(png).toEqual(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
  })
  it('creates an initial DOM rectangle using only safe hints and permits undo', async () => {
    const f = fixture({ element: { tag: 'button', selector: '#target', role: 'button', label: '', get text(): string { throw new Error('not displayed') },
      rect: { x: 10, y: 20, width: 50, height: 30 }, viewport: { width: 500, height: 250, scrollX: 999, scrollY: 999 } } })
    f.decode()
    expect(screen.getByText('#target')).toBeTruthy()
    expect(context.rect).toHaveBeenCalledWith(20, 40, 100, 60)
    await save()
    expect(f.props.onSave).toHaveBeenCalledWith(expect.objectContaining({ markCount: 1 }))
  })
  it('retains full ref-backed pen strokes across events and cancels incomplete pointers', async () => {
    const f = fixture(); f.decode()
    fireEvent.click(screen.getByRole('button', { name: labels.pen }))
    stroke(f.target)
    expect(context.lineTo).toHaveBeenCalledWith(200, 100)
    expect(context.lineTo).toHaveBeenCalledWith(300, 200)
    fireEvent.pointerDown(f.target, { pointerId: 8, button: 0, clientX: 150, clientY: 100 })
    fireEvent.pointerCancel(f.target, { pointerId: 8 })
    await save()
    expect(f.props.onSave).toHaveBeenCalledWith(expect.objectContaining({ markCount: 1 }))
  })
  it('refuses an over-budget stroke without discarding earlier marks', async () => {
    const f = fixture({ maxTextBytes: 325 }); f.decode()
    stroke(f.target)
    fireEvent.click(screen.getByRole('button', { name: labels.pen }))
    stroke(f.target)
    expect(screen.getByText(labels.drawingLimit)).toBeTruthy()
    await save()
    expect(f.props.onSave).toHaveBeenCalledWith(expect.objectContaining({ markCount: 1 }))
  })
  it('validates UTF-8 comments and encoded PNG bytes while preserving edits for retry', async () => {
    const f = fixture({ maxTextBytes: 5, maxImageBytes: 1 }); f.decode()
    fireEvent.change(screen.getByLabelText(labels.comment), { target: { value: '中文' } })
    expect(screen.getByText(labels.textLimit)).toBeTruthy()
    await save()
    expect(encode).not.toHaveBeenCalled()
    fireEvent.change(screen.getByLabelText(labels.comment), { target: { value: 'a' } })
    await save()
    expect(screen.getByText(labels.imageLimit)).toBeTruthy()
    expect((screen.getByLabelText(labels.comment) as HTMLTextAreaElement).value).toBe('a')
    expect(f.props.onSave).not.toHaveBeenCalled()
    f.view.rerender(<AnnotationEditor {...f.props} maxImageBytes={8} />)
    await save()
    expect(f.props.onSave).toHaveBeenCalledWith(expect.objectContaining({ comment: 'a' }))
  })
  it('keeps the frozen capture and drawing inspectable when its source page changes', async () => {
    const f = fixture(); f.decode(); stroke(f.target)
    f.view.rerender(<AnnotationEditor {...f.props} changed />)
    expect(screen.getByText(labels.changed)).toBeTruthy()
    await save()
    expect(f.props.onSave).not.toHaveBeenCalled()
    expect(images).toHaveLength(1)
    expect(screen.getByRole('button', { name: labels.undo }).hasAttribute('disabled')).toBe(false)
  })
  it('does not save after cancel, unmount or a page change during asynchronous PNG encoding', async () => {
    for (const mode of ['cancel', 'unmount', 'changed'] as const) {
      let complete: BlobCallback | undefined
      encode.mockImplementation((callback: BlobCallback) => { complete = callback })
      const f = fixture(); f.decode()
      fireEvent.click(screen.getByRole('button', { name: labels.save }))
      if (mode === 'cancel') fireEvent.click(screen.getByRole('button', { name: labels.cancel }))
      else if (mode === 'unmount') f.view.unmount()
      else f.view.rerender(<AnnotationEditor {...f.props} changed />)
      await act(async () => { complete?.(blob()) })
      expect(f.props.onSave).not.toHaveBeenCalled()
      if (mode === 'cancel') expect(f.props.onCancel).toHaveBeenCalledOnce()
      cleanup()
    }
  })
  it('cancels Escape from the comment field, never submits, and ignores late decode', () => {
    const f = fixture()
    const lateDecode = images[0]!.onload
    fireEvent.keyDown(screen.getByLabelText(labels.comment), { key: 'Escape' })
    expect(f.props.onCancel).toHaveBeenCalledOnce()
    act(() => { lateDecode?.() })
    expect(f.target.hidden).toBe(true)
    expect(f.props.onSave).not.toHaveBeenCalled()
  })
  it('remeasures display movement, clamps off-canvas drags, and ignores other pointer ids', async () => {
    const f = fixture(); f.decode()
    fireEvent.pointerDown(f.target, { pointerId: 7, button: 0, clientX: 120, clientY: 60 })
    fireEvent.pointerDown(f.target, { pointerId: 8, button: 0, clientX: 580, clientY: 280 })
    vi.mocked(f.target.getBoundingClientRect).mockReturnValue({ x: 200, y: 100, width: 250, height: 125,
      top: 100, left: 200, right: 450, bottom: 225, toJSON() {} })
    fireEvent.pointerMove(f.target, { pointerId: 8, clientX: 400, clientY: 200 })
    fireEvent.pointerUp(f.target, { pointerId: 7, clientX: 900, clientY: -100 })
    expect(context.rect).toHaveBeenCalledWith(40, 0, 960, 20)
    await save()
    expect(f.props.onSave).toHaveBeenCalledWith(expect.objectContaining({ markCount: 1 }))
  })
  it('checks exact byte budgets and suppresses completion after cancellation during blob reading', async () => {
    let finishRead: ((value: ArrayBuffer) => void) | undefined
    encode.mockImplementation((callback: BlobCallback) => callback({ size: png.byteLength, type: 'image/png',
      arrayBuffer: () => new Promise<ArrayBuffer>(resolve => { finishRead = resolve }) } as Blob))
    const f = fixture({ maxTextBytes: 6, maxImageBytes: png.byteLength }); f.decode()
    fireEvent.change(screen.getByLabelText(labels.comment), { target: { value: '中文' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: labels.save })) })
    expect(finishRead).toBeTypeOf('function')
    fireEvent.click(screen.getByRole('button', { name: labels.close }))
    await act(async () => { finishRead?.(new Uint8Array(png).buffer) })
    expect(f.props.onSave).not.toHaveBeenCalled()
    expect(f.props.onCancel).toHaveBeenCalledOnce()
  })
  it('shows localized decode and encoder failures with editing data retained', async () => {
    const failed = fixture()
    act(() => { images[0]!.onerror?.() })
    expect(screen.getByText(labels.decodeError)).toBeTruthy()
    failed.view.unmount()
    const f = fixture(); f.decode(); stroke(f.target)
    encode.mockImplementation((callback: BlobCallback) => callback(null))
    await save()
    expect(screen.getByText(labels.exportError)).toBeTruthy()
    encode.mockImplementation((callback: BlobCallback) => callback(blob()))
    await save()
    expect(f.props.onSave).toHaveBeenCalledWith(expect.objectContaining({ markCount: 1 }))
  })
})
