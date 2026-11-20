/** Read-only Bilibili page information, browser cues, and optional authorized site subtitle requests. */
import { enrichBilibiliSubtitles, md5Hex, wbiMixinKey, wbiSignedQuery } from './bilibili-subtitles.ts'
import type { VideoSubtitleDiagnostic } from '../browser/contract.ts'

/** Reasons an authorized subtitle request did not yield readable subtitle content. */
export type BilibiliSubtitleReason = 'not-available' | 'not-provided' | 'login-required' | 'access-denied' | 'request-failed' | 'timeout'

/** Validated video page snapshot, or a fixed content-free rejection. */
export type BilibiliReply =
  | { kind: 'video', url: string, title: string, text: string, format: 'text', coverage: 'loaded' } & (
    | { subtitleStatus: 'loaded' }
    | { subtitleStatus: 'not-loaded', subtitleReason?: BilibiliSubtitleReason, subtitleDiagnostic?: VideoSubtitleDiagnostic }
  )
  | { code: 'no-video' | 'too-large' }

/** @param url - Candidate page URL. @returns Whether it identifies a supported HTTPS Bilibili video without credentials or an explicit port. */
export function isBilibiliVideo(url: string): boolean {
  try {
    const address = new URL(url)
    return /^https:\/\/(?:www\.)?bilibili\.com\//i.test(url)
      && address.protocol === 'https:' && (address.hostname === 'www.bilibili.com' || address.hostname === 'bilibili.com')
      && address.username === '' && address.password === '' && address.port === ''
      && /^\/video\/(?:BV[A-Za-z0-9]{10}|av\d+)\/?$/.test(address.pathname)
  } catch (error) {
    // Invalid addresses are not video candidates.
    void error
    return false
  }
}

function readBilibili(maxBytes: number): BilibiliReply {
  // The fixed control reply is permitted even when the requested budget cannot hold it.
  if (maxBytes < 20) return { code: 'too-large' }
  const url = document.URL
  const address = new URL(url)
  if (!/^https:\/\/(?:www\.)?bilibili\.com\//i.test(url)
    || address.protocol !== 'https:' || (address.hostname !== 'www.bilibili.com' && address.hostname !== 'bilibili.com')
    || address.username !== '' || address.password !== '' || address.port !== ''
    || !/^\/video\/(?:BV[A-Za-z0-9]{10}|av\d+)\/?$/.test(address.pathname)) return { code: 'no-video' }

  const dom = {
    visible(element: Element): boolean {
      for (let current: Element | null = element; current !== null; current = current.parentElement) {
        const style = window.getComputedStyle(current)
        if (current.hasAttribute('hidden') || current.getAttribute('aria-hidden') === 'true'
          || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse'
          || (style.opacity !== '' && Number(style.opacity) === 0)) return false
      }
      return true
    },
    textOf(node: Node): string {
      if (node.nodeType === 3) return node.nodeValue ?? ''
      if (!(node instanceof Element) || !dom.visible(node) || node.matches('script,style,noscript,template')) return ''
      if (node.tagName === 'BR') return '\n'
      return Array.from(node.childNodes, dom.textOf).join('')
    },
    field(selector: string): string {
      const element = document.querySelector(selector)
      return element === null ? '' : dom.textOf(element).trim()
    },
  }
  // These page selectors are present in the public video HTML, not recommendation or comment roots.
  const title = dom.field('#viewbox_report.video-info-container h1.video-title')
  if (!title || /安全验证|访问受限|风控|captcha|security verification/i.test(document.title)) return { code: 'no-video' }
  const uploader = dom.field('.up-info-container .up-name')
  const description = dom.field('#v_desc.video-desc-container .desc-info-text')
  // Public core.a3c25289.js styles .bpx-player-video-wrap video; custom bwp-video is unsupported.
  // Its .bpx-player-subtitle-wrap is an overlay, not a verified transcript list template.
  const videos = Array.from(document.querySelectorAll('.bpx-player-video-wrap video'))
    .filter((element): element is HTMLVideoElement => element instanceof HTMLVideoElement && dom.visible(element))
  const subtitleLines: string[] = []
  const [video] = videos
  if (videos.length === 1 && video !== undefined) {
    const tracks = Array.from(video.textTracks).filter(track =>
      (track.kind === 'subtitles' || track.kind === 'captions') && (track.mode === 'showing' || track.mode === 'hidden'))
    const [track] = tracks
    if (tracks.length === 1 && track !== undefined) {
      const cues = track.cues
      if (cues !== null) {
        for (const cue of Array.from(cues)) {
          if ('text' in cue && typeof cue.text === 'string' && cue.text.trim()) {
            subtitleLines.push(`[${cue.startTime.toFixed(3)}s --> ${cue.endTime.toFixed(3)}s] ${cue.text}`)
          }
        }
      }
    }
  }
  const subtitleStatus = subtitleLines.length > 0 ? 'loaded' : 'not-loaded'
  const text = [
    'Video page information (DOM only; not audio/video understanding).',
    `Title: ${title}`,
    `Uploader: ${uploader || '[missing]'}`,
    `Description: ${description || '[missing]'}`,
    ...(subtitleStatus === 'loaded' ? [
      'Subtitles: currently loaded browser text-track cue list, in its existing order; completeness is not verified.',
      ...subtitleLines,
      'No ASR was performed.',
    ] : [
      'Subtitles: not read. No unambiguous loaded browser subtitle cue list was accessible; this does not mean the video has no subtitles.',
      'Only already loaded standard browser subtitle cues were read in this local capture; completeness is not verified.',
      'Check whether subtitles are enabled and accessible on the website before retrying. No ASR was performed.',
    ]),
  ].join('\n')
  const reply: BilibiliReply = { kind: 'video', url, title, text, format: 'text', coverage: 'loaded', subtitleStatus }
  return new TextEncoder().encode(JSON.stringify(reply)).byteLength <= maxBytes ? reply : { code: 'too-large' }
}

/** @param maxBytes - Complete UTF-8 JSON budget; undersized budgets reject before reading the DOM. @param subtitleRequestTimeoutMs - Explicit authorization for bounded normal-site subtitle requests; omitted keeps synchronous DOM-only behavior. @returns A fixed self-contained script without player interaction or document mutation; authorized requests use a total timeout and at most five requests: video identity, signing keys, signed player info, and at most two subtitle files. */
export function bilibiliVideoScript(maxBytes: number, subtitleRequestTimeoutMs?: number): string {
  const localBudget = subtitleRequestTimeoutMs !== undefined && maxBytes >= 20 ? Number.MAX_SAFE_INTEGER : maxBytes
  const local = `(${readBilibili.toString()})(${JSON.stringify(localBudget)})`
  return subtitleRequestTimeoutMs === undefined ? local
    : `(${enrichBilibiliSubtitles.toString()})(${local},${JSON.stringify(maxBytes)},${JSON.stringify(subtitleRequestTimeoutMs)},{md5:${md5Hex.toString()},mixinKey:${wbiMixinKey.toString()},signedQuery:${wbiSignedQuery.toString()}})`
}

/** @param reply - Unknown IPC JSON string or decoded value. @returns Validated owned fields only; malformed replies throw a fixed content-free error. */
export function decodeBilibiliReply(reply: unknown): BilibiliReply {
  try {
    const value: unknown = typeof reply === 'string' ? JSON.parse(reply) : reply
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid Bilibili reply')
    const data = value as Record<string, unknown>
    if (data.code === 'no-video' || data.code === 'too-large') return { code: data.code }
    if (data.kind !== 'video' || typeof data.url !== 'string' || !isBilibiliVideo(data.url)
      || typeof data.title !== 'string' || !data.title.trim() || typeof data.text !== 'string' || !data.text.trim()
      || data.format !== 'text' || data.coverage !== 'loaded'
      || (data.subtitleStatus !== 'loaded' && data.subtitleStatus !== 'not-loaded')) throw new Error('Invalid Bilibili reply')
    const reason = data.subtitleReason
    if (reason !== undefined && (data.subtitleStatus !== 'not-loaded'
      || (reason !== 'not-available' && reason !== 'not-provided' && reason !== 'login-required'
        && reason !== 'access-denied' && reason !== 'request-failed' && reason !== 'timeout'))) throw new Error('Invalid Bilibili reply')
    let subtitleDiagnostic: VideoSubtitleDiagnostic | undefined
    if (data.subtitleDiagnostic !== undefined) {
      if (data.subtitleStatus !== 'not-loaded' || typeof data.subtitleDiagnostic !== 'object' || data.subtitleDiagnostic === null
        || Array.isArray(data.subtitleDiagnostic)) throw new Error('Invalid Bilibili reply')
      const { stage, failure, httpStatus, apiCode } = data.subtitleDiagnostic as Record<string, unknown>
      if ((stage !== 'video-info' && stage !== 'subtitle-info' && stage !== 'subtitle-file')
        || (failure !== 'network' && failure !== 'http' && failure !== 'api' && failure !== 'json' && failure !== 'shape' && failure !== 'address')
        || (httpStatus !== undefined && (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || httpStatus < 0 || httpStatus > 599))
        || (apiCode !== undefined && (typeof apiCode !== 'number' || !Number.isInteger(apiCode) || apiCode < -2147483648 || apiCode > 2147483647))) throw new Error('Invalid Bilibili reply')
      subtitleDiagnostic = { stage, failure, ...(httpStatus === undefined ? {} : { httpStatus }), ...(apiCode === undefined ? {} : { apiCode }) }
    }
    const base = { kind: 'video' as const, url: data.url, title: data.title, text: data.text, format: 'text' as const, coverage: 'loaded' as const }
    return data.subtitleStatus === 'loaded' ? { ...base, subtitleStatus: 'loaded' }
      : { ...base, subtitleStatus: 'not-loaded', ...(reason === undefined ? {} : { subtitleReason: reason }),
        ...(subtitleDiagnostic === undefined ? {} : { subtitleDiagnostic }) }
  } catch (error) {
    // JSON and hostile property errors must not expose page content.
    void error
    throw new Error('Invalid Bilibili reply')
  }
}
