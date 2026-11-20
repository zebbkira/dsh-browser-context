/** Optional, bounded normal-site subtitle requests using only current-page video identifiers. */
import type { BilibiliReply } from './bilibili.ts'
import type { VideoSubtitleDiagnostic } from '../browser/contract.ts'

/** Pure signing functions inlined into the page script by the composer; see md5Hex, wbiMixinKey and wbiSignedQuery. */
export interface BilibiliWbiSigning {
  /** @param input - Text to digest. @returns Lowercase hexadecimal MD5 digest. */
  readonly md5: (input: string) => string
  /** @param imgKey - Key carried by the current image key URL. @param subKey - Key carried by the current alternate image key URL. @returns The 32-character signing key for this rotation. */
  readonly mixinKey: (imgKey: string, subKey: string) => string
  /** @param params - Request parameters without wts or w_rid. @param mixin - Signing key for this rotation. @param wts - Current unix seconds. @param md5 - MD5 implementation. @returns The sorted query with wts and w_rid appended. */
  readonly signedQuery: (params: Record<string, string>, mixin: string, wts: number, md5: (input: string) => string) => string
}

/**
 * RFC 1321 MD5 over UTF-8 bytes, used only to compute the site's request signature.
 * @param input - Text to digest.
 * @returns Lowercase hexadecimal digest.
 */
export function md5Hex(input: string): string {
  const shifts = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
  const sines = new Uint32Array(64)
  for (let index = 0; index < 64; index += 1) sines[index] = Math.floor(Math.abs(Math.sin(index + 1)) * 4294967296)
  // Fixed-range literal tables keep these fallbacks unreachable.
  const bytes = new TextEncoder().encode(input)
  const padded = new Uint8Array((((bytes.length + 8) >> 6) + 1) * 64)
  padded.set(bytes)
  padded[bytes.length] = 0x80
  const view = new DataView(padded.buffer)
  const bits = bytes.length * 8
  view.setUint32(padded.length - 8, bits >>> 0, true)
  view.setUint32(padded.length - 4, Math.floor(bits / 4294967296), true)
  let a0 = 0x67452301
  let b0 = 0xefcdab89
  let c0 = 0x98badcfe
  let d0 = 0x10325476
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = new Uint32Array(16)
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4, true)
    let a = a0
    let b = b0
    let c = c0
    let d = d0
    for (let index = 0; index < 64; index += 1) {
      let round = 0
      let slot = 0
      if (index < 16) { round = (b & c) | (~b & d); slot = index }
      else if (index < 32) { round = (d & b) | (~d & c); slot = (5 * index + 1) % 16 }
      else if (index < 48) { round = b ^ c ^ d; slot = (3 * index + 5) % 16 }
      else { round = c ^ (b | ~d); slot = (7 * index) % 16 }
      const sum = (round + a + (sines[index] ?? 0) + (words[slot] ?? 0)) | 0
      const shift = shifts[index] ?? 0
      a = d
      d = c
      c = b
      b = (b + ((sum << shift) | (sum >>> (32 - shift)))) | 0
    }
    a0 = (a0 + a) | 0
    b0 = (b0 + b) | 0
    c0 = (c0 + c) | 0
    d0 = (d0 + d) | 0
  }
  const digest = new DataView(new ArrayBuffer(16))
  digest.setUint32(0, a0, true)
  digest.setUint32(4, b0, true)
  digest.setUint32(8, c0, true)
  digest.setUint32(12, d0, true)
  return Array.from(new Uint8Array(digest.buffer), byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Derive the signing key for one key rotation from the two site-published key strings.
 * @param imgKey - Key carried by the current image key URL.
 * @param subKey - Key carried by the current alternate image key URL.
 * @returns The 32-character signing key for this rotation.
 */
export function wbiMixinKey(imgKey: string, subKey: string): string {
  // Site-published permutation, accepted by the signed player info endpoint; kept local so the
  // inlined page-script copy stays self-contained.
  const encTab = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]
  const raw = imgKey + subKey
  return encTab.map(index => raw[index] ?? '').join('').slice(0, 32)
}

/**
 * Build the signed query string for one site request.
 * @param params - Request parameters without wts or w_rid.
 * @param mixin - Signing key for this rotation.
 * @param wts - Current unix seconds.
 * @param md5 - MD5 implementation.
 * @returns The sorted query with wts and w_rid appended.
 */
export function wbiSignedQuery(params: Record<string, string>, mixin: string, wts: number, md5: (input: string) => string): string {
  const encoded = Object.keys(params).sort().map(key =>
    `${encodeURIComponent(key)}=${encodeURIComponent((params[key] ?? '').split('').filter(character => !/[!'()*]/.test(character)).join(''))}`)
  const query = `${encoded.join('&')}&wts=${wts}`
  return `${query}&w_rid=${md5(`${query}${mixin}`)}`
}

/**
 * @param initial - Fixed local video snapshot.
 * @param maxBytes - Complete UTF-8 JSON and subtitle-file byte budget; fixed metadata responses use a bounded larger ceiling.
 * @param timeoutMs - Positive total request timeout covering at most five requests.
 * @param signing - Pure site-signing functions inlined into the page script by the composer.
 * @returns A budgeted snapshot, without exposing request URLs or failures containing page data.
 */
export async function enrichBilibiliSubtitles(initial: BilibiliReply, maxBytes: number, timeoutMs: number, signing: BilibiliWbiSigning): Promise<BilibiliReply> {
  if (!('kind' in initial)) return initial
  if (initial.subtitleStatus === 'loaded') {
    return new TextEncoder().encode(JSON.stringify(initial)).byteLength <= maxBytes ? initial : { code: 'too-large' }
  }
  const tooLarge = {}
  const accessDenied = {}
  const timedOut = {}
  // The three fixed metadata endpoints can exceed the reply budget: collection videos embed their
  // whole season listing in the view response (over 150 KB in evidence). Keep a bounded larger
  // ceiling for those responses only; subtitle files stay under the reply budget.
  const metadataBytes = 4194304
  const controller = new AbortController()
  let diagnostic: VideoSubtitleDiagnostic = { stage: 'video-info', failure: 'shape' }
  const helpers = {
    start(stage: VideoSubtitleDiagnostic['stage']): void { diagnostic = { stage, failure: 'network' } },
    response(response: Response): void { diagnostic = { stage: diagnostic.stage, failure: 'http', httpStatus: response.status } },
    code(value: unknown): void {
      diagnostic = { ...diagnostic, failure: 'api', ...(typeof value === 'number' && Number.isInteger(value)
        && value >= -2147483648 && value <= 2147483647 ? { apiCode: value } : {}) }
    },
    data(owner: unknown, key: string): unknown {
      if (typeof owner !== 'object' || owner === null) return undefined
      const descriptor = Object.getOwnPropertyDescriptor(owner, key)
      return descriptor !== undefined && 'value' in descriptor ? descriptor.value : undefined
    },
    positive(value: unknown): value is number {
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    },
    bounded(reply: BilibiliReply): BilibiliReply {
      return new TextEncoder().encode(JSON.stringify(reply)).byteLength <= maxBytes ? reply : { code: 'too-large' }
    },
    failure(reason: 'not-available' | 'not-provided' | 'login-required' | 'access-denied' | 'request-failed' | 'timeout'): BilibiliReply {
      if (!('kind' in initial)) return initial
      const start = initial.text.lastIndexOf('\nSubtitles:')
      const metadata = start < 0 ? initial.text : initial.text.slice(0, start)
      const detail = reason === 'not-available'
        ? 'Current video/part identity not confirmed; subtitle file not requested.'
        : 'No accessible loaded subtitle content was obtained; this does not establish that the video has no subtitles.'
      return helpers.bounded({ ...initial, subtitleStatus: 'not-loaded', subtitleReason: reason,
        ...((reason === 'request-failed' || reason === 'timeout' || reason === 'access-denied' || reason === 'login-required') ? { subtitleDiagnostic: diagnostic } : {}), text: `${metadata}\nSubtitles: not read (${reason}). ${detail} No ASR was performed.` })
    },
    subtitleUrl(value: unknown): string | undefined {
      if (typeof value !== 'string') return undefined
      const raw = value.startsWith('//') ? `https:${value}` : value
      if (!/^https:\/\/[^/:?#]+\//i.test(raw)) return undefined
      try {
        const url = new URL(raw)
        const jsonPath = /^\/bfs\/(?:ai_subtitle|subtitle)\/[A-Za-z0-9_./-]+\.json$/.test(url.pathname)
        const aiPath = url.hostname === 'aisubtitle.hdslb.com' && /^\/bfs\/ai_subtitle\/prod\/[0-9a-f]+$/.test(url.pathname)
        if (url.protocol !== 'https:' || !url.hostname.endsWith('.hdslb.com') || url.username || url.password || url.port || url.hash
          || (!jsonPath && !aiPath)) return undefined
        return url.href
      } catch (error) {
        // Malformed site-provided resource addresses are not request targets.
        void error
        return undefined
      }
    },
    wbiKey(value: unknown): string | undefined {
      if (typeof value !== 'string' || value.length > 512) return undefined
      const base = value.slice(value.lastIndexOf('/') + 1)
      const dot = base.indexOf('.')
      const key = dot < 0 ? base : base.slice(0, dot)
      return /^[0-9a-f]{32}$/.test(key) ? key : undefined
    },
    async json(response: Response, budget: number): Promise<unknown> {
      diagnostic = { ...diagnostic, failure: 'json' }
      if (response.body === null) throw new Error('Unavailable response body')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.byteLength
          if (size > budget) {
            try { await reader.cancel() } catch (error) {
              // The oversized response is discarded even if cancellation also fails.
              void error
            }
            throw tooLarge
          }
          chunks.push(chunk.value)
        }
      } finally { reader.releaseLock() }
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    },
    async run(): Promise<BilibiliReply> {
      if (!('kind' in initial)) return initial
      const address = new URL(document.URL)
      if (address.href !== initial.url) return helpers.failure('not-available')
      const path = /^\/video\/(BV[A-Za-z0-9]{10}|av\d+)\/?$/.exec(address.pathname)
      const parts = address.searchParams.getAll('p')
      const videoId = path?.[1]
      const [partText] = parts
      if (videoId === undefined || parts.length > 1 || (partText !== undefined && !/^[1-9]\d*$/.test(partText))) return helpers.failure('not-available')
      const part = partText === undefined ? 1 : Number(partText)
      if (!helpers.positive(part)) return helpers.failure('not-available')
      if (document.URL !== initial.url) return helpers.failure('not-available')
      if (controller.signal.aborted) throw timedOut
      const query = videoId.startsWith('BV') ? `bvid=${videoId}` : `aid=${videoId.slice(2)}`
      helpers.start('video-info')
      const videoResponse = await fetch(`https://api.bilibili.com/x/web-interface/view?${query}`, {
        credentials: 'include', redirect: 'error', signal: controller.signal,
      })
      helpers.response(videoResponse)
      if (videoResponse.status === 403 || videoResponse.status === 412) return helpers.failure('access-denied')
      if (!videoResponse.ok) return helpers.failure('request-failed')
      const videoMetadata = await helpers.json(videoResponse, metadataBytes)
      const videoCode = helpers.data(videoMetadata, 'code')
      helpers.code(videoCode)
      if (videoCode === -101) return helpers.failure('login-required')
      if (videoCode === -403 || videoCode === -412) return helpers.failure('access-denied')
      if (videoCode !== 0) return helpers.failure('request-failed')
      diagnostic = { ...diagnostic, failure: 'shape' }
      const video = helpers.data(videoMetadata, 'data')
      const bvid = helpers.data(video, 'bvid')
      const aid = helpers.data(video, 'aid')
      if (typeof bvid !== 'string' || !/^BV[A-Za-z0-9]{10}$/.test(bvid) || !helpers.positive(aid)
        || (videoId.startsWith('BV') ? videoId !== bvid : Number(videoId.slice(2)) !== aid)) return helpers.failure('not-available')
      const pages = helpers.data(video, 'pages')
      if (!Array.isArray(pages) || pages.length > 10000) return helpers.failure('not-available')
      // Declared length of the current part in seconds; auto-generated tracks routinely cover only
      // part of it. Multi-part videos publish one whole-video length, so it is only a fallback.
      const duration = helpers.data(video, 'duration')
      let totalSeconds = helpers.positive(duration) ? duration : undefined
      const cids: number[] = []
      for (let index = 0; index < pages.length; index += 1) {
        const page = helpers.data(pages, String(index))
        if (helpers.data(page, 'page') !== part) continue
        const cid = helpers.data(page, 'cid')
        if (!helpers.positive(cid)) return helpers.failure('not-available')
        cids.push(cid)
        const pageDuration = helpers.data(page, 'duration')
        if (helpers.positive(pageDuration)) totalSeconds = pageDuration
      }
      const [cid] = cids
      if (cids.length !== 1 || cid === undefined || document.URL !== initial.url) return helpers.failure('not-available')
      // Shared cue download and rendering; an unusable file yields undefined so a caller can fall back.
      const readCues = async (url: string, provenance: string): Promise<BilibiliReply | undefined> => {
        if (controller.signal.aborted) throw timedOut
        helpers.start('subtitle-file')
        const content = await fetch(url, { credentials: 'omit', redirect: 'error', signal: controller.signal })
        helpers.response(content)
        if (content.status === 403 || content.status === 412) throw accessDenied
        if (!content.ok) return undefined
        const json = await helpers.json(content, maxBytes)
        diagnostic = { ...diagnostic, failure: 'shape' }
        const body = helpers.data(json, 'body')
        if (!Array.isArray(body) || body.length === 0) return undefined
        const lines: string[] = []
        let firstStart = Number.POSITIVE_INFINITY
        let lastEnd = 0
        for (const row of body) {
          const start = helpers.data(row, 'from')
          const end = helpers.data(row, 'to')
          const text = helpers.data(row, 'content')
          if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || typeof end !== 'number' || !Number.isFinite(end)
            || end < start || typeof text !== 'string') return undefined
          if (start < firstStart) firstStart = start
          if (end > lastEnd) lastEnd = end
          lines.push(`[${start.toFixed(3)}s --> ${end.toFixed(3)}s] ${text}`)
        }
        if (!lines.some(line => line.replace(/^\[[^\]]+\] /, '').trim())) return undefined
        // Cues ending far beyond the current part's declared length belong to another video: the
        // site's auto-generated pool has served cross-video files for the right identifiers.
        if (totalSeconds !== undefined && lastEnd > totalSeconds + 30) return undefined
        // A track ending well before the declared part length is the visible symptom of a partially
        // generated or mismatched site track; surface it instead of presenting the cues as complete.
        const coverageNote = totalSeconds !== undefined && lastEnd < totalSeconds * 0.9
          ? ` Subtitle coverage: ${firstStart.toFixed(3)}s-${lastEnd.toFixed(3)}s of ${totalSeconds.toFixed(3)}s; the site track covers only part of the video and may still be generating.`
          : ''
        const start = initial.text.lastIndexOf('\nSubtitles:')
        const metadataText = (start < 0 ? initial.text : initial.text.slice(0, start))
          .replace('Video page information (DOM only; not audio/video understanding).', 'Video page information and site-provided subtitles (not audio/video understanding).')
        return helpers.bounded({ kind: 'video', url: initial.url, title: initial.title, format: 'text', coverage: 'loaded', subtitleStatus: 'loaded', text: `${metadataText}\n${provenance}${coverageNote}\n${lines.join('\n')}\nNo ASR was performed.` })
      }
      // The signed player info request the page player itself makes; the legacy unsigned variant
      // still answers success but no longer carries usable per-track addresses.
      const siteTracks = async (): Promise<{ tracks: { url: string, label: string, lan: string }[] } | { rejection: BilibiliReply }> => {
        if (controller.signal.aborted) throw timedOut
        helpers.start('subtitle-info')
        const navResponse = await fetch('https://api.bilibili.com/x/web-interface/nav', {
          credentials: 'include', redirect: 'error', signal: controller.signal,
        })
        helpers.response(navResponse)
        if (navResponse.status === 403 || navResponse.status === 412) return { rejection: helpers.failure('access-denied') }
        if (!navResponse.ok) return { rejection: helpers.failure('request-failed') }
        // Anonymous sessions answer this key request with a login code but still publish keys.
        const navJson = await helpers.json(navResponse, metadataBytes)
        diagnostic = { ...diagnostic, failure: 'shape' }
        const wbiImg = helpers.data(helpers.data(navJson, 'data'), 'wbi_img')
        const imgKey = helpers.wbiKey(helpers.data(wbiImg, 'img_url'))
        // The site renamed the second key field; accept either published name.
        const subKey = helpers.wbiKey(helpers.data(wbiImg, 'sub_url') ?? helpers.data(wbiImg, 'img_sub_url'))
        if (imgKey === undefined || subKey === undefined || document.URL !== initial.url) return { rejection: helpers.failure('request-failed') }
        const playerQuery = signing.signedQuery({ aid: String(aid), cid: String(cid) }, signing.mixinKey(imgKey, subKey), Math.floor(Date.now() / 1000), signing.md5)
        helpers.start('subtitle-info')
        const response = await fetch(`https://api.bilibili.com/x/player/wbi/v2?${playerQuery}`, {
          credentials: 'include', redirect: 'error', signal: controller.signal,
        })
        helpers.response(response)
        if (response.status === 403 || response.status === 412) return { rejection: helpers.failure('access-denied') }
        if (!response.ok) return { rejection: helpers.failure('request-failed') }
        const metadata = await helpers.json(response, metadataBytes)
        const code = helpers.data(metadata, 'code')
        helpers.code(code)
        if (code === -101) return { rejection: helpers.failure('login-required') }
        if (code === -403 || code === -412) return { rejection: helpers.failure('access-denied') }
        if (code !== 0) return { rejection: helpers.failure('request-failed') }
        diagnostic = { ...diagnostic, failure: 'shape' }
        const data = helpers.data(metadata, 'data')
        const subtitle = helpers.data(data, 'subtitle')
        const tracks = helpers.data(subtitle, 'subtitles')
        if (!Array.isArray(tracks)) return { rejection: helpers.failure('request-failed') }
        if (tracks.length === 0) return { rejection: helpers.failure(helpers.data(data, 'need_login_subtitle') === true ? 'login-required' : 'not-provided') }
        diagnostic = { ...diagnostic, failure: 'address' }
        // Auto-generated tracks (lan codes like ai-zh) proved unreliable: they can cover only part of
        // a video, keep changing while being generated, or even carry another video's cues. Prefer
        // human-made tracks whenever the site offers both, and label what was actually read.
        const candidates: { url: string; label: string; lan: string }[] = []
        for (const track of tracks) {
          const candidate = helpers.subtitleUrl(helpers.data(track, 'subtitle_url'))
          const name = helpers.data(track, 'lan_doc')
          const lan = helpers.data(track, 'lan')
          const label = typeof name === 'string' && name.trim() && name.length <= 128 && !/https?:|\/\/|auth_key|[?&#=\r\n]/i.test(name)
            ? name : typeof lan === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(lan) ? lan : undefined
          if (candidate !== undefined && label !== undefined) {
            candidates.push({ url: candidate, label, lan: typeof lan === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(lan) ? lan : 'ai-unclassified' })
          }
        }
        if (candidates.length === 0) return { rejection: helpers.failure('request-failed') }
        return { tracks: candidates }
      }
      const site = await siteTracks()
      if (document.URL !== initial.url) return helpers.failure('not-available')
      // Deterministic primary source: the signed list for this page's verified current-part identity.
      if ('tracks' in site) {
        const target = site.tracks.find(item => !item.lan.startsWith('ai-')) ?? site.tracks[0]
        if (target !== undefined) {
          const generatedNote = target.lan.startsWith('ai-') ? 'auto-generated site track' : 'site track'
          const loaded = await readCues(target.url, `Subtitles: current video's site subtitle interface; human-made tracks are preferred over auto-generated ones. Language: ${target.label} (${target.lan}); ${generatedNote}, not verified against this video's audio or visuals; completeness is not verified.`)
          if (loaded !== undefined) return loaded
        }
      }
      // Remaining source when the signed list yields nothing usable: a subtitle file this page's own
      // player already requested. In-player navigation keeps earlier videos' entries in the resource
      // buffer, so this runs last and a cross-video file is rejected by its cue length above.
      if (!controller.signal.aborted) {
        const timing = typeof performance === 'object' && performance !== null && typeof performance.getEntriesByType === 'function'
          ? performance.getEntriesByType('resource') : []
        if (Array.isArray(timing) && timing.length <= 10000) {
          let played: string | undefined
          for (let index = timing.length - 1; index >= 0; index -= 1) {
            const entry: unknown = timing[index]
            const raw = typeof entry === 'object' && entry !== null ? Reflect.get(entry, 'name') : undefined
            const candidate = typeof raw === 'string' && raw !== '' ? helpers.subtitleUrl(raw) : undefined
            if (candidate !== undefined) { played = candidate; break }
          }
          if (played !== undefined && document.URL === initial.url) {
            const loaded = await readCues(played, 'Subtitles: loaded from this page\'s own player subtitle request (the track the player itself fetched); this source provides no language metadata; not verified against this video\'s audio or visuals; completeness is not verified.')
            if (loaded !== undefined) return loaded
          }
        }
      }
      if (document.URL !== initial.url) return helpers.failure('not-available')
      return 'rejection' in site ? site.rejection : helpers.failure('request-failed')
    },
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(timedOut) }, timeoutMs)
  })
  try { return await Promise.race([helpers.run(), timeout]) }
  catch (error) {
    if (error === tooLarge) return { code: 'too-large' }
    if (error === accessDenied) return helpers.failure('access-denied')
    return helpers.failure(error === timedOut || controller.signal.aborted ? 'timeout' : 'request-failed')
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
