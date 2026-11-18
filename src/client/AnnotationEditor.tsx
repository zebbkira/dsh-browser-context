/** Local, disposable annotation of one frozen native viewport PNG. */
import { useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { BrowserContextCapture } from '../browser/contract.ts'
import type { PickedElement } from '../browser/annotation.ts'
import { drawAnnotations, drawingCost, elementMark, imagePoint } from './annotation-drawing.ts'
import type { AnnotationMark, AnnotationPoint, AnnotationTool } from './annotation-drawing.ts'
import css from './AnnotationEditor.module.css'

/** Complete caller-localized copy; page-derived hints remain literal external text. */
export interface AnnotationEditorLabels {
  title: string
  close: string
  rectangle: string
  ellipse: string
  arrow: string
  pen: string
  tools: string
  undo: string
  clear: string
  comment: string
  canvas: string
  cancel: string
  save: string
  loading: string
  saving: string
  decodeError: string
  exportError: string
  textLimit: string
  imageLimit: string
  drawingLimit: string
  changed: string
}

/** Fresh real PNG bytes and the exact user comment; no page context is rebound here. */
export interface AnnotationEditorResult { bytes: Uint8Array; comment: string; markCount: number }
/** Mount a fresh editor for each capture; input bytes and picked geometry are borrowed read-only. */
export interface AnnotationEditorProps {
  image: Extract<BrowserContextCapture, { kind: 'viewport' }>
  element?: PickedElement
  labels: AnnotationEditorLabels
  maxTextBytes: number
  maxImageBytes: number
  onSave(result: AnnotationEditorResult): void
  onCancel(): void
  changed?: boolean
}

type Notice = 'decodeError' | 'exportError' | 'textLimit' | 'imageLimit' | 'drawingLimit'
interface Gesture { pointerId: number; tool: AnnotationTool; points: AnnotationPoint[] }

function preview(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:image/png;base64,${btoa(binary)}`
}

/**
 * Editing changes only local canvas geometry. Cancellation and teardown invalidate every async callback.
 * Export failures retain the marks and comment; changed page context blocks save without rebinding it.
 * @param props - frozen capture, caller-owned budgets, localized copy and explicit completion callbacks.
 * @returns a focus-contained shared Modal with bounded natural-pixel drawing and PNG export.
 */
export function AnnotationEditor(props: AnnotationEditorProps) {
  const { labels, maxTextBytes, changed = false } = props
  const [frozen] = useState(() => ({
    bytes: new Uint8Array(props.image.bytes),
    element: props.element === undefined ? undefined : {
      rect: { x: props.element.rect.x, y: props.element.rect.y,
        width: props.element.rect.width, height: props.element.rect.height },
      viewport: { width: props.element.viewport.width, height: props.element.viewport.height,
        scrollX: 0, scrollY: 0 },
      tag: props.element.tag,
      selector: props.element.selector,
    },
  }))
  const [tool, setTool] = useState<AnnotationTool>('rectangle')
  const [comment, setComment] = useState('')
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>()
  const [revision, setRevision] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null)
  const decoded = useRef<HTMLImageElement | undefined>(undefined)
  const marks = useRef<AnnotationMark[]>([])
  const gesture = useRef<Gesture | undefined>(undefined)
  const exporting = useRef(false)
  const lifecycle = useRef(new AbortController())
  const live = useRef(props)
  live.current = props
  const refresh = () => setRevision(value => value + 1)

  useEffect(() => {
    const owner = new AbortController()
    lifecycle.current = owner
    const image = new Image()
    image.onload = () => {
      if (owner.signal.aborted) return
      if (image.naturalWidth <= 0 || image.naturalHeight <= 0) { setNotice('decodeError'); return }
      decoded.current = image
      const initial = frozen.element === undefined ? undefined : elementMark(frozen.element, { width: image.naturalWidth, height: image.naturalHeight })
      if (initial !== undefined && drawingCost([initial]) <= live.current.maxTextBytes) marks.current = [initial]
      else if (initial !== undefined) setNotice('drawingLimit')
      setReady(true)
      refresh()
    }
    image.onerror = () => { if (!owner.signal.aborted) setNotice('decodeError') }
    image.src = preview(frozen.bytes)
    return () => {
      owner.abort()
      image.onload = null
      image.onerror = null
      decoded.current = undefined
      gesture.current = undefined
    }
  }, [frozen])

  useEffect(() => {
    const image = decoded.current
    const target = canvas.current
    if (!ready || image === undefined || target === null) return
    try {
      if (target.width !== image.naturalWidth) target.width = image.naturalWidth
      if (target.height !== image.naturalHeight) target.height = image.naturalHeight
      const context = target.getContext('2d')
      if (context === null) { setNotice('decodeError'); setReady(false); return }
      context.clearRect(0, 0, target.width, target.height)
      context.drawImage(image, 0, 0)
      const current = gesture.current
      drawAnnotations(context, current === undefined ? marks.current : [...marks.current, current],
        { width: target.width, height: target.height }, getComputedStyle(target).color)
    } catch (error) {
      // Canvas allocation/render failure leaves the original bytes and editing data intact.
      setNotice('decodeError')
      setReady(false)
    }
  }, [ready, revision])

  const cancel = () => {
    if (lifecycle.current.signal.aborted) return
    lifecycle.current.abort()
    gesture.current = undefined
    live.current.onCancel()
  }
  const position = (event: ReactPointerEvent<HTMLCanvasElement>) => imagePoint({ x: event.clientX, y: event.clientY },
    event.currentTarget.getBoundingClientRect(), { width: event.currentTarget.width, height: event.currentTarget.height })
  const release = (target: HTMLCanvasElement, pointerId: number) => {
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId)
  }
  const begin = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.stopPropagation()
    if (!ready || exporting.current || lifecycle.current.signal.aborted || gesture.current !== undefined || event.button !== 0) return
    const point = position(event)
    if (point === undefined) return
    const next: Gesture = { pointerId: event.pointerId, tool, points: [point, point] }
    if (drawingCost([...marks.current, next]) > maxTextBytes) { setNotice('drawingLimit'); return }
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    gesture.current = next
    setNotice(undefined)
    refresh()
  }
  const move = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.stopPropagation()
    const current = gesture.current
    if (current === undefined || current.pointerId !== event.pointerId) return
    event.preventDefault()
    const point = position(event)
    if (point === undefined) return
    if (current.tool === 'pen') {
      const last = current.points[current.points.length - 1]!
      if (last.x === point.x && last.y === point.y) return
      if (drawingCost([...marks.current, current]) + 32 > maxTextBytes) {
        gesture.current = undefined
        release(event.currentTarget, event.pointerId)
        setNotice('drawingLimit')
        refresh()
        return
      }
      current.points.push(point)
    } else current.points[1] = point
    refresh()
  }
  const finish = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    move(event)
    const current = gesture.current
    if (current === undefined || current.pointerId !== event.pointerId) return
    gesture.current = undefined
    marks.current.push({ tool: current.tool, points: current.points })
    release(event.currentTarget, event.pointerId)
    refresh()
  }
  const abandon = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    event.stopPropagation()
    if (gesture.current?.pointerId !== event.pointerId) return
    gesture.current = undefined
    release(event.currentTarget, event.pointerId)
    refresh()
  }
  const save = async () => {
    const image = decoded.current
    const target = canvas.current
    if (!ready || image === undefined || target === null || changed || exporting.current || lifecycle.current.signal.aborted || gesture.current !== undefined) return
    if (new TextEncoder().encode(comment).byteLength > maxTextBytes) { setNotice('textLimit'); return }
    const owner = lifecycle.current
    exporting.current = true
    setBusy(true)
    setNotice(undefined)
    let result: AnnotationEditorResult | undefined
    try {
      const output = document.createElement('canvas')
      output.width = image.naturalWidth
      output.height = image.naturalHeight
      const context = output.getContext('2d')
      if (context === null) throw new Error('canvas-context')
      context.drawImage(image, 0, 0)
      drawAnnotations(context, marks.current, { width: output.width, height: output.height }, getComputedStyle(target).color)
      const blob = await new Promise<Blob | null>(resolve => output.toBlob(resolve, 'image/png'))
      if (owner.signal.aborted) return
      if (blob === null || blob.type !== 'image/png') { setNotice('exportError'); return }
      if (blob.size > live.current.maxImageBytes) { setNotice('imageLimit'); return }
      const bytes = new Uint8Array(await blob.arrayBuffer())
      if (owner.signal.aborted || live.current.changed) return
      if (bytes.byteLength > live.current.maxImageBytes) { setNotice('imageLimit'); return }
      if (new TextEncoder().encode(comment).byteLength > live.current.maxTextBytes) { setNotice('textLimit'); return }
      result = { bytes, comment, markCount: marks.current.length }
    } catch (error) {
      // Encoding failure has no external effects; the user can retry the retained edit.
      if (!owner.signal.aborted) setNotice('exportError')
    } finally {
      exporting.current = false
      if (!owner.signal.aborted) setBusy(false)
    }
    if (result !== undefined && !owner.signal.aborted && !live.current.changed) {
      owner.abort()
      live.current.onSave(result)
    }
  }
  const textTooLarge = new TextEncoder().encode(comment).byteLength > maxTextBytes
  const tools: readonly AnnotationTool[] = ['rectangle', 'ellipse', 'arrow', 'pen']

  return <Modal open title={labels.title} closeLabel={labels.close} onClose={cancel}
    className={css.dialog ?? ''} contentClassName={css.content ?? ''}>
    <div className={css.editor} onKeyDown={event => {
      // The shared modal owns Tab trapping and composition-aware Escape dismissal.
      if (event.key !== 'Tab' && event.key !== 'Escape') event.stopPropagation()
    }}>
      <div role="group" aria-label={labels.tools} className={css.toolbar}>
        {tools.map(value => <Button key={value} size="sm" variant={tool === value ? 'outline' : 'ghost'}
          disabled={busy} aria-pressed={tool === value} onClick={() => setTool(value)}>{labels[value]}</Button>)}
        <Button size="sm" variant="ghost" disabled={busy || marks.current.length === 0} onClick={() => {
          gesture.current = undefined; marks.current.pop(); setNotice(undefined); refresh()
        }}>{labels.undo}</Button>
        <Button size="sm" variant="ghost" disabled={busy || marks.current.length === 0} onClick={() => {
          gesture.current = undefined; marks.current = []; setNotice(undefined); refresh()
        }}>{labels.clear}</Button>
      </div>
      {frozen.element !== undefined && <div className={css.element}><code>{frozen.element.tag}</code><code>{frozen.element.selector}</code></div>}
      <div className={css.viewport} aria-busy={!ready && notice === undefined}>
        {!ready && notice === undefined && <span role="status">{labels.loading}</span>}
        <canvas ref={canvas} className={css.canvas} aria-label={labels.canvas} hidden={!ready}
          onPointerDown={begin} onPointerMove={move} onPointerUp={finish}
          onPointerCancel={abandon} onLostPointerCapture={abandon} />
      </div>
      <label className={css.field}>
        <span>{labels.comment}</span>
        <textarea value={comment} disabled={busy} className={css.comment} aria-invalid={textTooLarge}
          onChange={event => { setComment(event.target.value); setNotice(undefined) }} />
      </label>
      <div className={css.status} aria-live="polite" role="status">
        {changed && <div>{labels.changed}</div>}
        {textTooLarge ? labels.textLimit : notice !== undefined ? labels[notice] : busy ? labels.saving : null}
      </div>
      <div className={css.actions}>
        <Button variant="ghost" onClick={cancel}>{labels.cancel}</Button>
        <Button variant="primary" disabled={!ready || busy || changed || textTooLarge || gesture.current !== undefined}
          aria-busy={busy} onClick={() => { void save() }}>{labels.save}</Button>
      </div>
    </div>
  </Modal>
}
