/** Plain, bounded local HTML snapshots; navigation carries a path, never document bytes. */
export interface LocalHtmlRequest { readonly path: string }
/** Authoritative settings for complete local document preparation and finite frame requests. */
export interface LocalHtmlLimits { readonly maxBytes: number; readonly maxFiles: number; readonly timeoutMs: number }
/** File identity comes only from the authorized file reader, never the rendered document. */
export interface LocalHtmlSource {
  readonly path: string
  readonly resourceAddress: string
  readonly version: string
}
/** An explicitly declared, authorized local dependency. */
export interface LocalHtmlAsset {
  readonly reference: string
  readonly kind: 'script' | 'stylesheet' | 'image'
  readonly mimeType: string
  readonly bytes: Uint8Array
}
/** Complete input for an opaque HTML frame; buffers are borrowed read-only and memory-only. */
export interface LocalHtmlBundle {
  readonly source: LocalHtmlSource
  readonly title: string
  readonly html: string
  readonly assets: readonly LocalHtmlAsset[]
}
/** Finite operations installed by the plugin inside the isolated file document. */
export type LocalHtmlCommand =
  | { readonly kind: 'status' }
  | { readonly kind: 'selection'; readonly maxBytes: number }
  | { readonly kind: 'pick'; readonly maxBytes: number; readonly instruction: string; readonly nonce: string }
  | { readonly kind: 'check'; readonly nonce: string }
  | { readonly kind: 'cancel'; readonly nonce: string }
/** Stable local-load failures contain no file bytes or raw remote exception text. */
export type LocalHtmlErrorCode = 'config' | 'read' | 'unsupported' | 'limit' | 'invalid' | 'changed' | 'closed' | 'timeout' | 'frame'
export class LocalHtmlError extends Error {
  constructor(readonly code: LocalHtmlErrorCode) { super(`Local HTML: ${code}`); this.name = 'LocalHtmlError' }
}
