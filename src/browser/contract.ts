/** Package-owned capture API; independent from optional or modified stock Browser APIs. */
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { ElementPickLimits, PickedElementCapture } from './annotation.ts'

/** A subtitle request can fail without invalidating the separately captured video page information. */
export type VideoSubtitleReason = 'not-available' | 'not-provided' | 'login-required' | 'access-denied' | 'request-failed' | 'timeout'

/** UI-only request diagnostics; never contains resource addresses, headers, response bodies, or credentials. */
export interface VideoSubtitleDiagnostic {
  readonly stage: 'video-info' | 'subtitle-info' | 'subtitle-file'
  readonly failure: 'network' | 'http' | 'api' | 'json' | 'shape' | 'address'
  readonly httpStatus?: number
  readonly apiCode?: number
}

/** Explicit data from this plugin's owned guest; image buffers are transient and borrowed read-only. */
export type BrowserContextCapture =
  | { readonly kind: 'selection'; readonly url: string; readonly title: string; readonly text: string }
  | { readonly kind: 'article'; readonly url: string; readonly title: string; readonly text: string; readonly format: 'markdown' }
  | { readonly kind: 'document'; readonly url: string; readonly title: string; readonly text: string; readonly format: 'text'; readonly coverage: 'loaded' }
  | { readonly kind: 'video'; readonly url: string; readonly title: string; readonly text: string; readonly format: 'text'; readonly coverage: 'loaded'; readonly subtitleStatus: 'loaded' | 'not-loaded'; readonly subtitleReason?: VideoSubtitleReason; readonly subtitleDiagnostic?: VideoSubtitleDiagnostic }
  | { readonly kind: 'viewport'; readonly url: string; readonly title: string; readonly mimeType: 'image/png'; readonly bytes: Uint8Array }

/** Finite semantic operations, never JavaScript, selectors or native guest handles. */
export type BrowserContextCaptureKind = BrowserContextCapture['kind']

/** Complete UTF-8 JSON metadata/text budget, plus raw PNG bytes for viewport capture. */
export interface BrowserContextCaptureLimits { readonly maxBytes: number; readonly subtitleRequestTimeoutMs?: number }

/** Stable operation failures, without page data in their messages. */
export type BrowserContextCaptureErrorCode = 'unsupported' | 'empty-selection' | 'no-article' | 'no-document' | 'no-video' | 'changed'
  | 'too-large' | 'closed' | 'cancelled' | 'unavailable' | 'invalid-limit' | 'copy-denied' | 'melo-unavailable' | 'melo-range-unavailable' | 'failed'

/** Consumers handle failures by code without importing an implementation class. */
export interface BrowserContextCaptureError extends Error { readonly code: BrowserContextCaptureErrorCode }

/** This plugin's tab occurrence and document generation, not the stock Browser's source identity. */
export interface BrowserContextSource {
  readonly tabId: TabId
  readonly url: string
  readonly title: string
  readonly generation: number
}

/** Owner props for browserContext.actions; only loaded, observed pages supply source. */
export interface BrowserActionsOwnerProps {
  readonly available: boolean
  readonly source?: BrowserContextSource | undefined
  /** @param kind - finite semantic capture. @param limits - complete output budget. @returns transient capture, or a typed rejection. */
  readonly capture: (kind: BrowserContextCaptureKind, limits: BrowserContextCaptureLimits) => Promise<BrowserContextCapture>
  /** Explicit element selection, cancelled by the caller or page lifetime; never exports a native guest. */
  readonly pickElement?: (limits: ElementPickLimits, signal: AbortSignal, instruction: string) => Promise<PickedElementCapture>
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Explicit references from this plugin's own guest; unrelated to stock Browser slots. */
    'browserContext.actions': { kind: 'list'; scope: 'session'; owner: BrowserActionsOwnerProps }
  }
}
