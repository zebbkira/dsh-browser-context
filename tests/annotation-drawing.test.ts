import { describe, expect, it, vi } from 'vitest'
import { annotationPath, clampPoint, drawAnnotations, drawingCost, elementMark, imagePoint, markRect } from '../src/client/annotation-drawing.ts'

const size = { width: 1000, height: 500 }

describe('frozen screenshot geometry', () => {
  it('maps each current display rectangle to natural image pixels without DPR or scroll offsets', () => {
    expect(imagePoint({ x: 170, y: 95 }, { x: 20, y: 20, width: 300, height: 150 }, size)).toEqual({ x: 500, y: 250 })
    expect(imagePoint({ x: 220, y: 150 }, { x: 120, y: 100, width: 200, height: 100 }, size)).toEqual({ x: 500, y: 250 })
    expect(imagePoint({ x: -10, y: 999 }, { x: 20, y: 20, width: 300, height: 150 }, size)).toEqual({ x: 0, y: 500 })
    expect(imagePoint({ x: 1, y: 1 }, { x: 0, y: 0, width: 0, height: 1 }, size)).toBeUndefined()
    expect(imagePoint({ x: 1, y: 1 }, { x: 0, y: 0, width: 1, height: 0 }, size)).toBeUndefined()
    expect(clampPoint({ x: 2000, y: -20 }, size)).toEqual({ x: 1000, y: 0 })
  })
  it('normalizes reverse drags for rectangle and ellipse paths', () => {
    const points = [{ x: 90, y: 80 }, { x: 10, y: 20 }]
    expect(markRect(points[0]!, points[1]!)).toEqual({ x: 10, y: 20, width: 80, height: 60 })
    expect(annotationPath({ tool: 'rectangle', points }, size)).toEqual([{ kind: 'rect', x: 10, y: 20, width: 80, height: 60 }])
    expect(annotationPath({ tool: 'ellipse', points }, size)).toEqual([{ kind: 'ellipse', x: 50, y: 50, radiusX: 40, radiusY: 30 }])
    expect(annotationPath({ tool: 'pen', points: [] }, size)).toEqual([])
  })
  it('clips all pen and arrowhead positions, including arrows pointing toward an edge', () => {
    const path = annotationPath({ tool: 'arrow', points: [{ x: 2000, y: -10 }, { x: 0, y: 0 }] }, size)
    expect(path.slice(0, 2)).toEqual([{ kind: 'move', x: 1000, y: 0 }, { kind: 'line', x: 0, y: 0 }])
    expect(path).toHaveLength(6)
    for (const point of path) {
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(size.width)
      expect(point.y).toBeGreaterThanOrEqual(0)
      expect(point.y).toBeLessThanOrEqual(size.height)
    }
    expect(annotationPath({ tool: 'pen', points: [{ x: -1, y: 30 }, { x: 40, y: 600 }] }, size))
      .toEqual([{ kind: 'move', x: 0, y: 30 }, { kind: 'line', x: 40, y: 500 }])
    expect(annotationPath({ tool: 'pen', points: [{ x: 2, y: 3 }] }, size))
      .toEqual([{ kind: 'move', x: 2, y: 3 }, { kind: 'line', x: 2, y: 3 }])
  })
  it('uses only picked rect and viewport dimensions, never scroll or sensitive extras', () => {
    const element = { rect: { x: -20, y: 25, width: 120, height: 75 },
      viewport: { width: 500, height: 250, get scrollX(): number { throw new Error('not used') }, get scrollY(): number { throw new Error('not used') } },
      get password(): string { throw new Error('not used') }, get text(): string { throw new Error('not used') } }
    expect(elementMark(element, size)).toEqual({ tool: 'rectangle', points: [{ x: 0, y: 50 }, { x: 200, y: 200 }] })
    expect(elementMark({ rect: element.rect, viewport: { width: 0, height: 100, scrollX: 0, scrollY: 0 } }, size)).toBeUndefined()
  })
  it('rejects empty picked geometry and conservatively charges every mark and point', () => {
    expect(elementMark({ rect: { x: 0, y: 0, width: 0, height: 4 }, viewport: { width: 5, height: 5, scrollX: 0, scrollY: 0 } }, size)).toBeUndefined()
    expect(drawingCost([])).toBe(0)
    expect(drawingCost([{ tool: 'pen', points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }])).toBe(160)
  })
  it('renders the same clipped paths into a canvas context without changing geometry', () => {
    const context = { save: vi.fn(), restore: vi.fn(), beginPath: vi.fn(), rect: vi.fn(), clip: vi.fn(),
      moveTo: vi.fn(), lineTo: vi.fn(), ellipse: vi.fn(), stroke: vi.fn(), strokeStyle: '', lineWidth: 0, lineCap: 'round', lineJoin: 'round' }
    const marks = [{ tool: 'rectangle' as const, points: [{ x: 1, y: 2 }, { x: 3, y: 6 }] },
      { tool: 'ellipse' as const, points: [{ x: 1, y: 2 }, { x: 3, y: 6 }] },
      { tool: 'arrow' as const, points: [{ x: 1, y: 2 }, { x: 30, y: 60 }] }]
    const before = JSON.stringify(marks)
    drawAnnotations(context as CanvasRenderingContext2D, marks, size, 'red')
    expect(context.rect).toHaveBeenCalledWith(0, 0, 1000, 500)
    expect(context.rect).toHaveBeenCalledWith(1, 2, 2, 4)
    expect(context.ellipse).toHaveBeenCalledWith(2, 4, 1, 2, 0, 0, Math.PI * 2)
    expect(context.clip).toHaveBeenCalledOnce()
    expect(context.stroke).toHaveBeenCalledTimes(3)
    expect(context.restore).toHaveBeenCalledOnce()
    expect(JSON.stringify(marks)).toBe(before)
  })
})
