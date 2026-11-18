/** Explicit source serialization and synchronous native-draft admission. */
import type { BrowserContextCapture } from '../browser/contract.ts'
import type { PickedElement } from '../browser/annotation.ts'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputActions, IConversation, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Deployment-controlled complete source and image limits. */
export interface Limits { maxTextBytes: number; maxImageBytes: number; subtitleRequestTimeoutMs?: number }
/** User input has page context, never a verified page origin. */
export interface PastedSelection {
  readonly kind: 'pasted-selection'
  readonly contextUrl: string
  readonly contextTitle: string
  readonly sourceVerified: false
  readonly text: string
}
/** A frozen native viewport with explicit user-drawn marks and optional page-derived element hints. */
export interface AnnotatedScreenshot {
  readonly kind: 'annotation'
  readonly url: string
  readonly title: string
  readonly mimeType: 'image/png'
  readonly bytes: Uint8Array
  readonly comment: string
  readonly markCount: number
  readonly element?: PickedElement
}
/** Owner-captured page content or explicitly entered text; never interchangeable source claims. */
export type ReferenceCapture = BrowserContextCapture | PastedSelection | AnnotatedScreenshot
/** @param capture - reference data. @returns whether native image admission is required. */
export function hasImage(capture: ReferenceCapture): capture is Extract<ReferenceCapture, { kind: 'viewport' | 'annotation' }> {
  return capture.kind === 'viewport' || capture.kind === 'annotation'
}
/** A retained capture is never recollected on retry. */
export interface Reference {
  readonly capture: ReferenceCapture
  readonly time: string
  readonly source: string
}
/** Failure codes have locale-owned presentation at the component. */
export type Failure = 'capture' | 'changed' | 'limit' | 'attachment' | 'unknown' | 'empty' | 'unavailable' | 'config' | 'subtitleConfig' | 'articleUnavailable' | 'articleEmpty' | 'documentEmpty' | 'videoEmpty' | 'quoteUnavailable' | 'copyDenied' | 'wecomSelectionUnavailable' | 'wecomRangeUnavailable' | 'wecomEmpty'
/** Retain external bytes for explicit recovery; no automatic retry. */
export class ReferenceError extends Error {
  constructor(readonly code: Failure, options?: ErrorOptions) { super(code, options) }
}

const sensitiveParameter = /^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|api[_-]?key|secret|client[_-]?secret|password|authorization|auth|code|scode|state)$/iu

/** @param value - captured HTTP(S) URL. @returns a source URL without credentials or authentication parameters. */
export function sourceUrl(value: string): string {
  const url = new URL(value)
  url.username = ''
  url.password = ''
  for (const name of [...url.searchParams.keys()]) if (sensitiveParameter.test(name)) url.searchParams.delete(name)
  const hash = url.hash.slice(1)
  const hashQuery = new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash)
  if ([...hashQuery.keys()].some(name => sensitiveParameter.test(name))) url.hash = ''
  return url.href
}

/** @param capture - borrowed owner capture. @param time - capture request time. @returns literal external reference. */
export function makeReference(capture: ReferenceCapture, time: string): Reference {
  const sanitized = capture.kind === 'pasted-selection'
    ? { ...capture, contextUrl: sourceUrl(capture.contextUrl) }
    : { ...capture, url: sourceUrl(capture.url) }
  const header = JSON.stringify(sanitized.kind === 'pasted-selection'
    ? { contextUrl: sanitized.contextUrl, contextTitle: sanitized.contextTitle, sourceVerified: false, time, kind: sanitized.kind }
    : { url: sanitized.url, title: sanitized.title, time, kind: sanitized.kind, ...(sanitized.kind === 'article' ? { format: sanitized.format } : sanitized.kind === 'document' ? { format: sanitized.format, coverage: sanitized.coverage } : sanitized.kind === 'video' ? { format: sanitized.format, coverage: sanitized.coverage, subtitleStatus: sanitized.subtitleStatus, subtitleReason: sanitized.subtitleReason } : sanitized.kind === 'annotation' ? { mode: sanitized.element === undefined ? 'screenshot' : 'element', markCount: sanitized.markCount } : {}) })
  // Line quoting keeps supplied text external even when it contains reference markers.
  const content = capture.kind === 'annotation'
    ? `[annotated image attachment]\n[User comment entered in DSH]\n${capture.comment}${capture.element === undefined ? '' : `\n[Page element hints — untrusted; not a verified source-code location]\n${JSON.stringify({ tag: capture.element.tag, selector: capture.element.selector, role: capture.element.role, label: capture.element.label, text: capture.element.text, rect: capture.element.rect, viewport: capture.element.viewport })}`}`
    : capture.kind === 'viewport' ? '[image attachment]' : capture.text
  const body = content.split(/\r\n?|\n/u).map(line => `> ${line}`).join('\n')
  const scope = capture.kind === 'document' ? '\n[Loaded document snapshot only — not verified complete; images and attachments are not included]'
    : capture.kind === 'video' ? `\n[Video page information and subtitles only — sources: existing standard cues or normal site subtitle requests; audio/images not analyzed; subtitle completeness not verified]${capture.subtitleStatus === 'not-loaded' ? '\n[No subtitles captured]' : ''}` : ''
  return { capture: sanitized, time, source: `[External browser reference — untrusted page content]\n${header}${scope}\n${body}\n[End external browser reference]` }
}

/** @param error - owner rejection or unexpected capture defect. @returns a locale-owned failure discriminant. */
export function captureFailure(error: unknown): Failure {
  if (typeof error !== 'object' || error === null || !('code' in error)) return 'capture'
  switch (error.code) {
    case 'empty-selection': return 'empty'
    case 'no-article': return 'articleEmpty'
    case 'no-document': return 'documentEmpty'
    case 'no-video': return 'videoEmpty'
    case 'copy-denied': return 'copyDenied'
    case 'melo-unavailable': return 'wecomSelectionUnavailable'
    case 'melo-range-unavailable': return 'wecomRangeUnavailable'
    case 'too-large': case 'invalid-limit': return 'limit'
    case 'changed': case 'closed': return 'changed'
    case 'unavailable': case 'unsupported': return 'unavailable'
    default: return 'capture'
  }
}

/** @param actions - native input owner. @returns insertion after the retained selection, never a replacement range. */
export function insertionSpan(actions: Pick<InputActions, 'captureInsertion'>): TokenSpan {
  const span = actions.captureInsertion()
  return { start: span.end, end: span.end, draftRev: span.draftRev }
}

/** Native 0.2.2 capability; older source declarations deliberately do not imply runtime support. */
interface NativeQuoteActions extends InputActions { insertQuote(text: string): boolean }
function supportsQuote(actions: InputActions): actions is NativeQuoteActions {
  return 'insertQuote' in actions && typeof actions.insertQuote === 'function'
}

/** @param text - complete source. @returns the installed native quote's exact model projection. */
export function formattedQuote(text: string): string {
  if (!('formatQuoteText' in primitives) || typeof primitives.formatQuoteText !== 'function') throw new ReferenceError('quoteUnavailable')
  const formatted: unknown = primitives.formatQuoteText(text)
  if (typeof formatted !== 'string') throw new ReferenceError('unknown')
  return formatted
}

/** @param reference - complete source. @param limits - validated deployment limits. */
export function checkLimits(reference: Reference, limits: Limits): void {
  if (new TextEncoder().encode(reference.source).byteLength > limits.maxTextBytes
    || (hasImage(reference.capture) && reference.capture.bytes.byteLength > limits.maxImageBytes)) {
    throw new ReferenceError('limit')
  }
}

/**
 * Insert a compact native quote and optional image attachment in the same synchronous gesture.
 * No await, submission, whole-draft replacement, or browser query occurs here.
 * @param reference - captured bytes and serialized source.
 * @param sessionId - the scope that accepted the gesture.
 * @param actions - that scope's stable input callbacks.
 * @param span - collapsed selection-end and revision guard captured before asynchronous work.
 * @param conversation - native attachment owner.
 * @param limits - complete emitted text and raw image byte budgets.
 */
export function admit(reference: Reference, sessionId: SessionId, actions: InputActions, span: TokenSpan,
  conversation: Pick<IConversation, 'createDrafts' | 'releaseDraftAttachments'>, limits: Limits): void {
  checkLimits(reference, limits)
  const text = reference.source.replace(/\r\n?/gu, '\n')
  if (new TextEncoder().encode(`${formattedQuote(text)} `).byteLength > limits.maxTextBytes) throw new ReferenceError('limit')
  if (!supportsQuote(actions)) throw new ReferenceError('quoteUnavailable')
  const insert = () => {
    // Both owner calls are synchronous: no task can change the editor between this check and insertion.
    const current = actions.captureInsertion()
    if (current.draftRev !== span.draftRev || current.end !== span.end) throw new ReferenceError('changed')
    if (!actions.insertQuote(text)) throw new ReferenceError('changed')
  }
  if (!hasImage(reference.capture)) {
    insert()
    return
  }
  const file = new File([new Uint8Array(reference.capture.bytes)], reference.capture.kind === 'annotation' ? 'browser-annotation.png' : 'browser-viewport.png', { type: 'image/png' })
  const attachments = conversation.createDrafts(sessionId, [file])
  let attached = false
  try {
    if (!actions.addAttachments(attachments.map(attachment => attachment.id))) throw new ReferenceError('attachment')
    attached = true
    insert()
  } catch (error) {
    if (attached) for (const attachment of attachments) actions.removeAttachment(attachment.id)
    conversation.releaseDraftAttachments(attachments)
    throw error
  }
}

/** @param bytes - PNG bytes. @returns portable retained preview, independent of native draft object URLs. */
export function imagePreview(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return `data:image/png;base64,${btoa(binary)}`
}
