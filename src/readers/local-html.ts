/** Memory-only preparation of direct HTML assets; no document code receives a file-reading capability. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceByteReadOptions, WorkspaceFileBytes } from '@deepseek-ai/dsh-api-workspace-files/types'
import { LocalHtmlError } from '../browser/local-html-types.ts'
import type { LocalHtmlAsset, LocalHtmlBundle, LocalHtmlLimits } from '../browser/local-html-types.ts'

/**
 * Complete-byte reads bound by the caller to the captured Session; Host authorization remains mandatory.
 * @param path - root path or validated, decoded relative dependency path.
 * @param options - empty for the root; canonical root baseFile for dependencies; never a guessed range.
 * @param signal - operation deadline and external cancellation.
 * @returns the official Remote result without converting denied or partial reads to success.
 */
export type LocalHtmlRead = (path: string, options: WorkspaceByteReadOptions, signal: AbortSignal) => Promise<RemoteResult<WorkspaceFileBytes>>

type Dependency = { reference: string; path: string; kind: LocalHtmlAsset['kind']; mimeType: string }
const imageTypes: Readonly<Record<string, string>> = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
  gif: 'image/gif', ico: 'image/x-icon', avif: 'image/avif', bmp: 'image/bmp',
}

function decode(data: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data) }
  catch (_error) { throw new LocalHtmlError('invalid') }
}

/** Match the static util/workspace-path file-address grammar, preserving absolute-path leading slashes. */
function sourceAddress(sessionId: SessionId, path: string): string {
  const encode = (part: string): string => encodeURIComponent(part).replace(/%3A/giu, ':')
  return `dsh-resource://file/session/${encode(sessionId)}/${path.replace(/\\/gu, '/').split('/').map(encode).join('/')}`
}

function canonical(path: string): string {
  const normalized = path.replace(/\\/gu, '/')
  if (!/^(?:\/|[a-z]:\/)/iu.test(normalized) || /[\0-\x1f\x7f]/u.test(normalized)
    || normalized.split('/').some(part => part === '.' || part === '..')) throw new LocalHtmlError('invalid')
  return normalized
}

/** Return no local path for permitted non-file URLs; never normalize traversal before checking it. */
function relativePath(reference: string): string | undefined {
  if (/[\0-\x1f\x7f]/u.test(reference)) throw new LocalHtmlError('invalid')
  const value = reference.trim()
  if (/^(?:https?:|data:|blob:)/iu.test(value)) return undefined
  if (/^[a-z][a-z\d+.-]*:/iu.test(value)) throw new LocalHtmlError('unsupported')
  try { decodeURIComponent(value) }
  catch (_error) { throw new LocalHtmlError('invalid') }
  if (value.startsWith('#') || value === '') return undefined
  const path = value.split(/[?#]/u, 1)[0]!
  if (/%(?:2f|5c)/iu.test(path)) throw new LocalHtmlError('invalid')
  let decoded: string
  try { decoded = decodeURIComponent(path) }
  catch (_error) { throw new LocalHtmlError('invalid') }
  if (!decoded || /^(?:\/|\\|[a-z][a-z\d+.-]*:)/iu.test(decoded) || /[\\\0-\x1f\x7f]/u.test(decoded)
    || decoded.split('/').some(part => part === '..')) throw new LocalHtmlError('invalid')
  // Nested encodings are ambiguous to downstream URL parsers and are not supported file names here.
  if (/%[\da-f]{2}/iu.test(decoded)) throw new LocalHtmlError('invalid')
  return decoded
}

function cssDependencies(css: string): void {
  // Escaped identifiers and imports need a CSS parser; do not guess their dependency graph.
  if (css.includes('\\')) throw new LocalHtmlError('unsupported')
  const clean = css.replace(/\/\*[\s\S]*?\*\//gu, '')
  if (/@import\b/iu.test(clean)) throw new LocalHtmlError('unsupported')
  for (const match of clean.matchAll(/url\s*\(([^)]*)\)/giu)) {
    const value = match[1]!.trim().replace(/^(['"])([\s\S]*)\1$/u, '$2')
    if (relativePath(value) !== undefined) throw new LocalHtmlError('unsupported')
  }
  if (/url\s*\(/iu.test(clean.replace(/url\s*\([^)]*\)/giu, ''))) throw new LocalHtmlError('unsupported')
}

function scriptDependencies(script: string): void {
  // This is a conservative refusal, not a JS import rewriter or a complete program analysis.
  if (/\b(?:import|fetch)\s*(?:\(|["'{*])/u.test(script)) throw new LocalHtmlError('unsupported')
}

function dependencies(content: DocumentFragment): Dependency[] {
  if (content.querySelector('base[href],script[type="module" i],picture,[srcset]')) throw new LocalHtmlError('unsupported')
  const result: Dependency[] = []
  const seen = new Set<string>()
  for (const element of content.querySelectorAll('*')) {
    // Validate URL schemes even on elements that are not file dependencies.
    for (const name of ['src', 'href', 'action', 'formaction', 'poster', 'xlink:href']) {
      const value = element.getAttribute(name)
      if (value !== null) relativePath(value)
    }
    const style = element.getAttribute('style')
    if (style !== null) cssDependencies(style)
    if (element.localName === 'style') cssDependencies(element.textContent ?? '')
    if (element.localName === 'script') {
      if ((element.getAttribute('type') ?? '').trim().toLowerCase() === 'module') throw new LocalHtmlError('unsupported')
      if (!element.hasAttribute('src')) scriptDependencies(element.textContent ?? '')
    }
    const kind = element.localName === 'script' ? 'script' : element.localName === 'img' ? 'image'
      : element.localName === 'link' && (element.getAttribute('rel') ?? '').toLowerCase().split(/\s+/u).includes('stylesheet') ? 'stylesheet' : undefined
    if (kind === undefined) continue
    const reference = element.getAttribute(kind === 'stylesheet' ? 'href' : 'src')
    if (reference === null) continue
    const path = relativePath(reference)
    if (path === undefined) continue
    const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
    const type = (element.getAttribute('type') ?? '').trim().toLowerCase()
    if (kind === 'script' && (!['', 'text/javascript', 'application/javascript'].includes(type) || extension !== 'js')) throw new LocalHtmlError('unsupported')
    if (kind === 'stylesheet' && extension !== 'css') throw new LocalHtmlError('unsupported')
    const mimeType = kind === 'script' ? 'text/javascript' : kind === 'stylesheet' ? 'text/css' : imageTypes[extension]
    if (mimeType === undefined) throw new LocalHtmlError('unsupported')
    const key = `${kind}:${reference}`
    if (!seen.has(key)) { result.push({ reference, path, kind, mimeType }); seen.add(key) }
  }
  return result
}

/** Base64 wire accounting includes every JSON key, escaped string, source field, title and asset wrapper. */
function serializedBytes(bundle: LocalHtmlBundle): number {
  const json = JSON.stringify({ ...bundle, assets: bundle.assets.map(asset => ({ ...asset, bytes: '' })) })
  return new TextEncoder().encode(json).byteLength + bundle.assets.reduce((sum, asset) => sum + 4 * Math.ceil(asset.bytes.byteLength / 3), 0)
}

/**
 * Prepare one complete HTML snapshot using only authorized sequential reads of pre-parsed direct references.
 * No HTML is mounted or executed and no network request is made. Supports classic .js, .css and common images.
 * Base URLs, modules, srcset/picture, CSS imports/escaped syntax/local URLs and recognizable import()/fetch()
 * programs are unsupported. This is not a dynamic dependency resolver; computed URLs never trigger disk reads.
 * Failures discard all partial output; cancellation/deadline abort the callback and prevent success publication.
 * @param sessionId - captured Session identity; the caller must bind readBytes to this same Session.
 * @param path - captured root HTML/HTM path, reauthorized by readBytes.
 * @param readBytes - Session-bound official workspace byte reader, never a renderer message handler.
 * @param limits - raw-byte, complete serialized bundle, direct-reference count and total-deadline limits.
 * @param signal - external cancellation, reported with the stable closed code.
 * @returns complete in-memory bundle; all failures are content-free LocalHtmlError values.
 */
export async function prepareLocalHtml(
  sessionId: SessionId, path: string, readBytes: LocalHtmlRead, limits: LocalHtmlLimits, signal: AbortSignal,
): Promise<LocalHtmlBundle> {
  if (!Number.isSafeInteger(limits.maxBytes) || limits.maxBytes <= 0 || !Number.isSafeInteger(limits.maxFiles) || limits.maxFiles < 0
    || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs <= 0 || limits.timeoutMs > 2_147_483_647) throw new LocalHtmlError('config')
  if (!/\.html?$/iu.test(path) || path.includes('\0')) throw new LocalHtmlError('unsupported')
  const controller = new AbortController()
  const cancel = (): void => { controller.abort(new LocalHtmlError('closed')) }
  signal.addEventListener('abort', cancel, { once: true })
  if (signal.aborted) cancel()
  const deadline = Date.now() + limits.timeoutMs
  const timer = setTimeout(() => { controller.abort(new LocalHtmlError('timeout')) }, limits.timeoutMs)
  const check = (): void => {
    if (controller.signal.aborted) throw controller.signal.reason
    if (Date.now() >= deadline) { controller.abort(new LocalHtmlError('timeout')); throw controller.signal.reason }
  }
  let total = 0
  const read = async (target: string, options: WorkspaceByteReadOptions): Promise<WorkspaceFileBytes> => {
    check()
    let stop!: () => void
    const cancelled = new Promise<never>((_resolve, reject) => {
      stop = () => { reject(controller.signal.reason) }
      controller.signal.addEventListener('abort', stop, { once: true })
    })
    try {
      let result: RemoteResult<WorkspaceFileBytes>
      try { result = await Promise.race([readBytes(target, options, controller.signal), cancelled]) }
      catch (_error) { check(); throw new LocalHtmlError('read') }
      check()
      if (!result.ok) throw new LocalHtmlError('read')
      const file = result.value
      if (file.offset !== 0 || file.eof !== true || (file.bytes !== undefined && file.bytes !== file.data.byteLength)) throw new LocalHtmlError('invalid')
      total += file.data.byteLength
      if (total > limits.maxBytes) throw new LocalHtmlError('limit')
      canonical(file.absolutePath)
      return file
    } finally { controller.signal.removeEventListener('abort', stop) }
  }
  try {
    const root = await read(path, {})
    const rootPath = canonical(root.absolutePath)
    if (!/\.html?$/iu.test(rootPath)) throw new LocalHtmlError('unsupported')
    const html = decode(root.data)
    // Template contents are inert, including images; DOMParser documents may initiate resource loads.
    const template = document.createElement('template')
    template.innerHTML = html
    const references = dependencies(template.content)
    if (references.length > limits.maxFiles) throw new LocalHtmlError('limit')
    const assets: LocalHtmlAsset[] = []
    const bundle: LocalHtmlBundle = {
      source: { path: root.absolutePath, resourceAddress: sourceAddress(sessionId, root.absolutePath), version: root.version },
      title: template.content.querySelector('title')?.textContent?.trim() || rootPath.split('/').at(-1)!, html, assets,
    }
    if (serializedBytes(bundle) > limits.maxBytes) throw new LocalHtmlError('limit')
    const directory = rootPath.slice(0, rootPath.lastIndexOf('/') + 1)
    const windows = /^[a-z]:\//iu.test(rootPath) || rootPath.startsWith('//')
    for (const dependency of references) {
      const file = await read(dependency.path, { baseFile: root.absolutePath })
      const resolved = canonical(file.absolutePath)
      if (!(windows ? resolved.toLowerCase().startsWith(directory.toLowerCase()) : resolved.startsWith(directory))) throw new LocalHtmlError('invalid')
      if (dependency.kind === 'stylesheet') cssDependencies(decode(file.data))
      if (dependency.kind === 'script') scriptDependencies(decode(file.data))
      assets.push({ reference: dependency.reference, kind: dependency.kind, mimeType: dependency.mimeType, bytes: file.data })
      if (serializedBytes(bundle) > limits.maxBytes) throw new LocalHtmlError('limit')
    }
    check()
    return bundle
  } catch (error) {
    if (error instanceof LocalHtmlError) throw error
    throw new LocalHtmlError('invalid')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}
