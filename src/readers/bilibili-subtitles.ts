/** Optional, bounded normal-site subtitle requests using only current-page video identifiers. */
import type { BilibiliReply } from './bilibili.ts'
import type { VideoSubtitleDiagnostic } from '../browser/contract.ts'

/** @param initial - Fixed local video snapshot. @param maxBytes - Complete UTF-8 JSON and per-response byte budget. @param timeoutMs - Positive total request timeout. @returns A budgeted snapshot, without exposing request URLs or failures containing page data. */
export async function enrichBilibiliSubtitles(initial: BilibiliReply, maxBytes: number, timeoutMs: number): Promise<BilibiliReply> {
  if (!('kind' in initial)) return initial
  if (initial.subtitleStatus === 'loaded') {
    return new TextEncoder().encode(JSON.stringify(initial)).byteLength <= maxBytes ? initial : { code: 'too-large' }
  }
  const tooLarge = {}
  const timedOut = {}
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
    async json(response: Response): Promise<unknown> {
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
          if (size > maxBytes) {
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
      const videoMetadata = await helpers.json(videoResponse)
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
      const cids: number[] = []
      for (let index = 0; index < pages.length; index += 1) {
        const page = helpers.data(pages, String(index))
        if (helpers.data(page, 'page') !== part) continue
        const cid = helpers.data(page, 'cid')
        if (!helpers.positive(cid)) return helpers.failure('not-available')
        cids.push(cid)
      }
      const [cid] = cids
      if (cids.length !== 1 || cid === undefined || document.URL !== initial.url) return helpers.failure('not-available')
      if (controller.signal.aborted) throw timedOut
      // Documented normal player endpoint; no signature calculation, alternative endpoint, or retry.
      helpers.start('subtitle-info')
      const response = await fetch(`https://api.bilibili.com/x/player/v2?cid=${cid}&bvid=${bvid}`, {
        credentials: 'include', redirect: 'error', signal: controller.signal,
      })
      helpers.response(response)
      if (response.status === 403 || response.status === 412) return helpers.failure('access-denied')
      if (!response.ok) return helpers.failure('request-failed')
      const metadata = await helpers.json(response)
      const code = helpers.data(metadata, 'code')
      helpers.code(code)
      if (code === -101) return helpers.failure('login-required')
      if (code === -403 || code === -412) return helpers.failure('access-denied')
      if (code !== 0) return helpers.failure('request-failed')
      diagnostic = { ...diagnostic, failure: 'shape' }
      const data = helpers.data(metadata, 'data')
      const subtitle = helpers.data(data, 'subtitle')
      const tracks = helpers.data(subtitle, 'subtitles')
      if (!Array.isArray(tracks)) return helpers.failure('request-failed')
      if (tracks.length === 0) return helpers.failure(helpers.data(data, 'need_login_subtitle') === true ? 'login-required' : 'not-provided')
      diagnostic = { ...diagnostic, failure: 'address' }
      let target: string | undefined
      let language = ''
      for (const track of tracks) {
        const candidate = helpers.subtitleUrl(helpers.data(track, 'subtitle_url'))
        const name = helpers.data(track, 'lan_doc')
        const code = helpers.data(track, 'lan')
        const label = typeof name === 'string' && name.trim() && name.length <= 128 && !/https?:|\/\/|auth_key|[?&#=\r\n]/i.test(name)
          ? name : typeof code === 'string' && /^[A-Za-z0-9_-]{1,32}$/.test(code) ? code : undefined
        if (candidate !== undefined && label !== undefined) { target = candidate; language = label; break }
      }
      if (target === undefined) return helpers.failure('request-failed')
      if (document.URL !== initial.url) return helpers.failure('not-available')
      if (controller.signal.aborted) throw timedOut
      helpers.start('subtitle-file')
      const content = await fetch(target, { credentials: 'omit', redirect: 'error', signal: controller.signal })
      helpers.response(content)
      if (content.status === 403 || content.status === 412) return helpers.failure('access-denied')
      if (!content.ok) return helpers.failure('request-failed')
      const json = await helpers.json(content)
      diagnostic = { ...diagnostic, failure: 'shape' }
      const body = helpers.data(json, 'body')
      if (!Array.isArray(body) || body.length === 0) return helpers.failure('request-failed')
      const lines: string[] = []
      for (const row of body) {
        const start = helpers.data(row, 'from')
        const end = helpers.data(row, 'to')
        const text = helpers.data(row, 'content')
        if (typeof start !== 'number' || !Number.isFinite(start) || start < 0 || typeof end !== 'number' || !Number.isFinite(end)
          || end < start || typeof text !== 'string') return helpers.failure('request-failed')
        lines.push(`[${start.toFixed(3)}s --> ${end.toFixed(3)}s] ${text}`)
      }
      if (!lines.some(line => line.replace(/^\[[^\]]+\] /, '').trim())) return helpers.failure('request-failed')
      const start = initial.text.lastIndexOf('\nSubtitles:')
      const metadataText = (start < 0 ? initial.text : initial.text.slice(0, start))
        .replace('Video page information (DOM only; not audio/video understanding).', 'Video page information and site-provided subtitles (not audio/video understanding).')
      return helpers.bounded({ kind: 'video', url: initial.url, title: initial.title, format: 'text', coverage: 'loaded', subtitleStatus: 'loaded', text: `${metadataText}\nSubtitles: current video's site subtitle interface; first available valid site track. Language: ${language}. Loaded subtitle entries only; completeness is not verified.\n${lines.join('\n')}\nNo ASR was performed.` })
    },
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(timedOut) }, timeoutMs)
  })
  try { return await Promise.race([helpers.run(), timeout]) }
  catch (error) {
    if (error === tooLarge) return { code: 'too-large' }
    return helpers.failure(error === timedOut || controller.signal.aborted ? 'timeout' : 'request-failed')
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
