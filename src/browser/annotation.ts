/** Plain element-selection data from one explicitly picked, owned page snapshot. */
import type { BrowserContextCapture } from './contract.ts'

/** CSS-pixel rectangle clipped to the current viewport. */
export interface AnnotationRect { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
/** Page-derived hints, never instructions, credentials or a source-code location. */
export interface PickedElement {
  readonly tag: string
  readonly selector: string
  readonly role: string
  readonly label: string
  readonly text: string
  readonly rect: AnnotationRect
  readonly viewport: { readonly width: number; readonly height: number; readonly scrollX: number; readonly scrollY: number }
}
/** The native image and selected element belong to the same observed document. */
export interface PickedElementCapture {
  readonly image: Extract<BrowserContextCapture, { kind: 'viewport' }>
  readonly element: PickedElement
}
/** Separate complete budgets for page hints and native image bytes. */
export interface ElementPickLimits { readonly maxTextBytes: number; readonly maxImageBytes: number }
