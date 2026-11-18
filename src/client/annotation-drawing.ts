/** Natural-image-pixel geometry and canvas rendering; never reads page or element extras. */
import type { AnnotationRect, PickedElement } from '../browser/annotation.ts'

/** Tools supported by the frozen screenshot editor. */
export type AnnotationTool = 'rectangle' | 'ellipse' | 'arrow' | 'pen'
/** One position in natural image pixels, independent of device pixel ratio. */
export interface AnnotationPoint { readonly x: number; readonly y: number }
/** Natural image or CSS display dimensions. */
export interface AnnotationSize { readonly width: number; readonly height: number }
/** A bounded mark; pen points are limited by the caller's drawing budget. */
export interface AnnotationMark { readonly tool: AnnotationTool; readonly points: readonly AnnotationPoint[] }
/** Canvas path operations, also consumable by geometry tests without a DOM. */
export type AnnotationPath =
  | { readonly kind: 'move' | 'line'; readonly x: number; readonly y: number }
  | { readonly kind: 'rect'; readonly x: number; readonly y: number; readonly width: number; readonly height: number }
  | { readonly kind: 'ellipse'; readonly x: number; readonly y: number; readonly radiusX: number; readonly radiusY: number }

/** @param point - image-space point. @param size - natural dimensions. @returns a new point clipped to the image. */
export function clampPoint(point: AnnotationPoint, size: AnnotationSize): AnnotationPoint {
  return { x: Math.min(size.width, Math.max(0, point.x)), y: Math.min(size.height, Math.max(0, point.y)) }
}

/**
 * @param point - pointer client position.
 * @param bounds - current canvas boundingClientRect, measured for each event.
 * @param size - natural image dimensions, never multiplied by DPR.
 * @returns a clipped image position, or undefined for a collapsed display.
 */
export function imagePoint(point: AnnotationPoint, bounds: AnnotationRect, size: AnnotationSize): AnnotationPoint | undefined {
  if (bounds.width <= 0 || bounds.height <= 0) return undefined
  return clampPoint({ x: (point.x - bounds.x) * size.width / bounds.width,
    y: (point.y - bounds.y) * size.height / bounds.height }, size)
}

/** @param start - first endpoint. @param end - opposite endpoint. @returns a positive-size rectangle for either drag direction. */
export function markRect(start: AnnotationPoint, end: AnnotationPoint): AnnotationRect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y),
    width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) }
}

/**
 * CSS viewport and element rect share a coordinate system; document scroll is not added.
 * @param element - only viewport dimensions and rect are inspected.
 * @param size - decoded PNG dimensions.
 * @returns an initial rectangle mark or undefined for an empty viewport/rectangle.
 */
export function elementMark(element: Pick<PickedElement, 'rect' | 'viewport'>, size: AnnotationSize): AnnotationMark | undefined {
  const { rect, viewport } = element
  if (viewport.width <= 0 || viewport.height <= 0) return undefined
  const start = clampPoint({ x: rect.x * size.width / viewport.width, y: rect.y * size.height / viewport.height }, size)
  const end = clampPoint({ x: (rect.x + rect.width) * size.width / viewport.width,
    y: (rect.y + rect.height) * size.height / viewport.height }, size)
  if (start.x === end.x || start.y === end.y) return undefined
  return { tool: 'rectangle', points: [start, end] }
}

/** @param mark - natural-pixel mark. @param size - natural dimensions. @returns clipped path commands, including an arrowhead. */
export function annotationPath(mark: AnnotationMark, size: AnnotationSize): AnnotationPath[] {
  const points = mark.points.map(point => clampPoint(point, size))
  const start = points[0]
  if (start === undefined) return []
  const end = points[points.length - 1]!
  if (mark.tool === 'rectangle' || mark.tool === 'ellipse') {
    const rect = markRect(start, end)
    return mark.tool === 'rectangle' ? [{ kind: 'rect', ...rect }]
      : [{ kind: 'ellipse', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
        radiusX: rect.width / 2, radiusY: rect.height / 2 }]
  }
  const path: AnnotationPath[] = [{ kind: 'move', ...start }]
  if (mark.tool === 'pen') {
    for (const point of points.slice(1)) path.push({ kind: 'line', ...point })
    if (points.length === 1) path.push({ kind: 'line', ...start })
    return path
  }
  path.push({ kind: 'line', ...end })
  const angle = Math.atan2(end.y - start.y, end.x - start.x)
  const length = Math.min(Math.hypot(end.x - start.x, end.y - start.y) / 3, Math.min(size.width, size.height) * 0.035)
  for (const offset of [-Math.PI / 6, Math.PI / 6]) {
    const head = clampPoint({ x: end.x - length * Math.cos(angle + offset), y: end.y - length * Math.sin(angle + offset) }, size)
    path.push({ kind: 'move', ...end }, { kind: 'line', ...head })
  }
  return path
}

/**
 * Account retained numeric geometry conservatively; object overhead is bounded by the same budget.
 * @param marks - committed marks plus any current gesture.
 * @returns budget units charged against maxTextBytes, not serialized source text.
 */
export function drawingCost(marks: readonly AnnotationMark[]): number {
  return marks.reduce((cost, mark) => cost + 96 + mark.points.length * 32, 0)
}

/**
 * @param context - target canvas context at its unscaled natural dimensions.
 * @param marks - bounded geometry in natural pixels.
 * @param size - decoded PNG dimensions.
 * @param color - resolved theme accent, retained for both preview and PNG export.
 */
export function drawAnnotations(context: CanvasRenderingContext2D, marks: readonly AnnotationMark[], size: AnnotationSize, color: string): void {
  context.save()
  context.beginPath()
  context.rect(0, 0, size.width, size.height)
  context.clip()
  context.strokeStyle = color
  context.lineWidth = Math.max(1, Math.min(size.width, size.height) / 250)
  context.lineCap = 'round'
  context.lineJoin = 'round'
  for (const mark of marks) {
    context.beginPath()
    for (const command of annotationPath(mark, size)) {
      switch (command.kind) {
        case 'move': context.moveTo(command.x, command.y); break
        case 'line': context.lineTo(command.x, command.y); break
        case 'rect': context.rect(command.x, command.y, command.width, command.height); break
        case 'ellipse': context.ellipse(command.x, command.y, command.radiusX, command.radiusY, 0, 0, Math.PI * 2); break
      }
    }
    context.stroke()
  }
  context.restore()
}
