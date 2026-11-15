/** Package-owned bounded capture helpers; no stock Browser runtime dependencies. */
import type { BrowserContextCapture, BrowserContextCaptureError, BrowserContextCaptureErrorCode, BrowserContextCaptureLimits } from './contract.ts'

/** Internal stable error; consumer imports only the structural public type. */
export class CaptureError extends Error implements BrowserContextCaptureError {
  constructor(readonly code: BrowserContextCaptureErrorCode, options?: ErrorOptions) {
    super(`Reference browser capture: ${code}`, options)
    this.name = 'BrowserContextCaptureError'
  }
}

/** @param limits - caller output budget. @throws CaptureError when invalid. */
export function validateLimits(limits: BrowserContextCaptureLimits): void {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes < 0) throw new CaptureError('invalid-limit')
}

/** @param capture - complete result. @param limits - output budget. @returns unchanged result, or rejects without truncation. */
export function boundCapture(capture: BrowserContextCapture, limits: BrowserContextCaptureLimits): BrowserContextCapture {
  const metadata = capture.kind !== 'viewport' ? capture
    : { kind: capture.kind, url: capture.url, title: capture.title, mimeType: capture.mimeType }
  const size = new TextEncoder().encode(JSON.stringify(metadata)).byteLength
    + (capture.kind === 'viewport' ? capture.bytes.byteLength : 0)
  if (size > limits.maxBytes) throw new CaptureError('too-large')
  return capture
}

/** @param dataURL - native PNG string. @param maxBytes - complete output upper bound. @returns browser-decoded PNG bytes without Node Buffer. */
export function pngBytes(dataURL: string, maxBytes: number): Uint8Array {
  const prefix = 'data:image/png;base64,'
  if (!dataURL.startsWith(prefix)) throw new CaptureError('failed')
  const encoded = dataURL.slice(prefix.length)
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) throw new CaptureError('failed')
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  const size = encoded.length / 4 * 3 - padding
  if (size > maxBytes) throw new CaptureError('too-large')
  if (size === 0) throw new CaptureError('failed')
  let binary: string
  try { binary = atob(encoded) }
  catch (_error) { throw new CaptureError('failed') }
  return Uint8Array.from(binary, value => value.charCodeAt(0))
}
