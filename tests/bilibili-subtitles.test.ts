// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInContext } from 'node:vm'
import { createHash } from 'node:crypto'
import { JSDOM } from 'jsdom'
import { bilibiliVideoScript, decodeBilibiliReply } from '../src/readers/bilibili.ts'
import { md5Hex, wbiMixinKey, wbiSignedQuery } from '../src/readers/bilibili-subtitles.ts'

const bvid = 'BV1qStU63ERs'
const address = `https://www.bilibili.com/video/${bvid}/?p=2&vd_source=generated`
const cdn = 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/generated.json?auth_key=generated-sensitive-key'
const html = '<div id="viewbox_report" class="video-info-container"><h1 class="video-title">Generated title😀</h1></div><div class="up-info-container"><a class="up-name">Generated uploader</a></div><div id="v_desc" class="video-desc-container"><span class="desc-info-text">Generated description</span></div>'
const imgKey = '7cd084941338484a551c35290155e16c'
const subKey = '57e1c3527b78de5c9b3a4a1e4d0f3d2c'
const mixin = wbiMixinKey(imgKey, subKey)
const nav = (subField = 'sub_url') => ({ code: -101, data: { wbi_img: { img_url: `https://i0.hdslb.com/bfs/wbi/${imgKey}.png`, [subField]: `https://i0.hdslb.com/bfs/wbi/${subKey}.png` } } })
const videoMetadata = (duration?: number, partDuration?: number) => ({ code: 0, data: { bvid, aid: 123, ...(duration === undefined ? {} : { duration }), pages: [{ page: 1, cid: 101, ...(partDuration === undefined ? {} : { duration: partDuration }) }, { page: 2, cid: 202, ...(partDuration === undefined ? {} : { duration: partDuration }) }] } })
const track = (subtitle_url = cdn, lan = 'generated', lan_doc = 'Generated language') => ({ subtitle_url, lan_doc, lan })
const metadata = (tracks: object[] = [track()]) => ({ code: 0, data: { subtitle: { subtitles: tracks } } })
const body = () => ({ body: [{ from: 3.25, to: 4.5, content: 'Generated second cue😀' }, { from: 1, to: 2, content: 'Generated first cue' }] })
const bodyTo = (end: number) => ({ body: [{ from: 1, to: end, content: 'Generated cue' }] })
const json = (value: object, status = 200) => new Response(JSON.stringify(value), { status })
const playerInfo = /^https:\/\/api\.bilibili\.com\/x\/player\/wbi\/v2\?aid=123&cid=202&wts=\d{10}&w_rid=[0-9a-f]{32}$/

function page(url = address, queueIdentity = true) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
  const fetch = vi.fn<typeof globalThis.fetch>()
  if (queueIdentity) fetch.mockResolvedValueOnce(json(videoMetadata())).mockResolvedValueOnce(json(nav()))
  for (const [key, value] of Object.entries({ TextEncoder, TextDecoder, AbortController, fetch, setTimeout, clearTimeout })) Reflect.set(dom.window, key, value)
  const capture = async (budget = 65536, timeout = 15000) => decodeBilibiliReply(await runInContext(bilibiliVideoScript(budget, timeout), dom.getInternalVMContext()))
  return { dom, fetch, capture }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('authorized normal-site Bilibili subtitles', () => {
  it('requests current-part identity, signing keys, and signed player info, then only the first valid site JSON track', async () => {
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(metadata([track('https://evil.test/generated.json'), track()]))).mockResolvedValueOnce(json(body()))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ kind: 'video', url: address, subtitleStatus: 'loaded', coverage: 'loaded' })
      expect(reply).not.toHaveProperty('subtitleReason')
      if (!('kind' in reply)) throw new Error('Expected page snapshot')
      expect(reply.text).toContain('[3.250s --> 4.500s] Generated second cue😀\n[1.000s --> 2.000s] Generated first cue')
      expect(reply.text).toContain('human-made tracks are preferred over auto-generated ones. Language: Generated language (generated); site track, not verified against this video\'s audio or visuals')
      expect(reply.text).toContain('completeness is not verified')
      expect(reply.text).not.toContain('Subtitle coverage:')
      expect(reply.text).toContain('not audio/video understanding')
      expect(reply.text).toContain('No ASR was performed')
      expect(reply.text).not.toContain('DOM only')
      expect(JSON.stringify(reply)).not.toMatch(/auth_key|generated-sensitive-key|aisubtitle\.hdslb/)
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(fetch.mock.calls[0]?.[0]).toBe(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`)
      expect(fetch.mock.calls[1]?.[0]).toBe('https://api.bilibili.com/x/web-interface/nav')
      expect(fetch.mock.calls[2]?.[0]).toMatch(playerInfo)
      expect(fetch.mock.calls[3]?.[0]).toBe(cdn)
      for (const url of fetch.mock.calls.map(call => String(call[0]))) expect(url).not.toContain('/x/player/v2?')
      for (const index of [0, 1, 2]) expect(fetch.mock.calls[index]?.[1]).toMatchObject({ credentials: 'include', redirect: 'error' })
      expect(fetch.mock.calls[3]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
      for (const [, options] of fetch.mock.calls) {
        expect(options?.signal).toBe(fetch.mock.calls[0]?.[1]?.signal)
        expect(options).not.toHaveProperty('headers')
      }
    } finally { dom.window.close() }
  })

  it('prefers a human-made track over an auto-generated one when the site offers both', async () => {
    const manualTrack = track('https://aisubtitle.hdslb.com/bfs/subtitle/manual-track.json', 'zh-Hans', '简体中文')
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(metadata([track(cdn, 'ai-zh', '中文（自动生成）'), manualTrack]))).mockResolvedValueOnce(json(body()))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleStatus: 'loaded' })
      if (!('kind' in reply)) throw new Error('Expected page snapshot')
      expect(reply.text).toContain('Language: 简体中文 (zh-Hans); site track')
      expect(reply.text).not.toContain('auto-generated site track')
      expect(fetch.mock.calls[3]?.[0]).toBe('https://aisubtitle.hdslb.com/bfs/subtitle/manual-track.json')
    } finally { dom.window.close() }
  })

  it('labels an auto-generated track and reports its coverage against the declared video length', async () => {
    const { dom, fetch, capture } = page(address, false)
    fetch.mockResolvedValueOnce(json(videoMetadata(600))).mockResolvedValueOnce(json(nav()))
      .mockResolvedValueOnce(json(metadata([track(cdn, 'ai-zh', '中文（自动生成）')]))).mockResolvedValueOnce(json(body()))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleStatus: 'loaded' })
      if (!('kind' in reply)) throw new Error('Expected page snapshot')
      expect(reply.text).toContain('auto-generated site track, not verified')
      expect(reply.text).toContain('Subtitle coverage: 1.000s-4.500s of 600.000s; the site track covers only part of the video and may still be generating.')
    } finally { dom.window.close() }
  })

  it('measures coverage against the current part length rather than the whole-video length', async () => {
    const { dom, fetch, capture } = page(address, false)
    fetch.mockResolvedValueOnce(json(videoMetadata(600, 4))).mockResolvedValueOnce(json(nav()))
      .mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleStatus: 'loaded' })
      expect(JSON.stringify(reply)).not.toContain('Subtitle coverage:')
    } finally { dom.window.close() }
  })

  it('omits the coverage note when cues reach most of the declared video length', async () => {
    const { dom, fetch, capture } = page(address, false)
    fetch.mockResolvedValueOnce(json(videoMetadata(4))).mockResolvedValueOnce(json(nav()))
      .mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleStatus: 'loaded' })
      expect(JSON.stringify(reply)).not.toContain('Subtitle coverage:')
    } finally { dom.window.close() }
  })

  const playerTrack = 'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/playerloaded.json?auth_key=generated-sensitive-key'
  function withPlayerResource(dom: JSDOM, ...urls: string[]): void {
    const fake = { getEntriesByType: (kind: string) => kind === 'resource' ? urls.map(name => ({ name })) : [] }
    // JSDOM exposes window.performance through a prototype getter, so plain assignment is silently ignored.
    Object.defineProperty(dom.window, 'performance', { value: fake, configurable: true })
  }

  it('uses the signed site list deterministically even when a player resource entry exists', async () => {
    const { dom, fetch, capture } = page()
    withPlayerResource(dom, playerTrack)
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleStatus: 'loaded', coverage: 'loaded' })
      if (!('kind' in reply)) throw new Error('Expected page snapshot')
      expect(reply.text).toContain('site subtitle interface; human-made tracks are preferred')
      expect(reply.text).not.toContain("player subtitle request")
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(fetch.mock.calls[3]?.[0]).toBe(cdn)
      for (const url of fetch.mock.calls.map(call => String(call[0]))) expect(url).not.toBe(playerTrack)
    } finally { dom.window.close() }
  })

  it('falls back to the player-requested subtitle URL when the signed list offers no tracks', async () => {
    const { dom, fetch, capture } = page()
    withPlayerResource(dom, playerTrack)
    fetch.mockResolvedValueOnce(json(metadata([]))).mockResolvedValueOnce(json(body()))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleStatus: 'loaded', coverage: 'loaded' })
      if (!('kind' in reply)) throw new Error('Expected page snapshot')
      expect(reply.text).toContain("loaded from this page's own player subtitle request (the track the player itself fetched)")
      expect(reply.text).toContain('completeness is not verified')
      expect(reply.text).toContain('No ASR was performed')
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(fetch.mock.calls[3]?.[0]).toBe(playerTrack)
      expect(JSON.stringify(reply)).not.toMatch(/auth_key|generated-sensitive-key/)
    } finally { dom.window.close() }
  })

  it('falls back to the player-requested subtitle URL when the site track file is unreadable', async () => {
    const { dom, fetch, capture } = page()
    withPlayerResource(dom, playerTrack)
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json({}, 500)).mockResolvedValueOnce(json(body()))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleStatus: 'loaded' })
      if (!('kind' in reply)) throw new Error('Expected page snapshot')
      expect(reply.text).toContain("this page's own player subtitle request")
      expect(fetch).toHaveBeenCalledTimes(5)
      expect(fetch.mock.calls[3]?.[0]).toBe(cdn)
      expect(fetch.mock.calls[4]?.[0]).toBe(playerTrack)
    } finally { dom.window.close() }
  })

  it('rejects a site track whose cues end beyond the current part length', async () => {
    const { dom, fetch, capture } = page(address, false)
    fetch.mockResolvedValueOnce(json(videoMetadata(100, 100))).mockResolvedValueOnce(json(nav()))
      .mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(bodyTo(500)))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleStatus: 'not-loaded', subtitleReason: 'request-failed', subtitleDiagnostic: { stage: 'subtitle-file', failure: 'shape', httpStatus: 200 } })
      expect(fetch).toHaveBeenCalledTimes(4)
    } finally { dom.window.close() }
  })

  it('rejects a player resource track whose cues end beyond the current part length', async () => {
    const { dom, fetch, capture } = page(address, false)
    withPlayerResource(dom, playerTrack)
    fetch.mockResolvedValueOnce(json(videoMetadata(100, 100))).mockResolvedValueOnce(json(nav()))
      .mockResolvedValueOnce(json(metadata([]))).mockResolvedValueOnce(json(bodyTo(500)))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleReason: 'not-provided' })
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(fetch.mock.calls[3]?.[0]).toBe(playerTrack)
    } finally { dom.window.close() }
  })

  it.each([[125, { subtitleStatus: 'loaded' }], [131, { subtitleStatus: 'not-loaded', subtitleReason: 'request-failed' }]] as const)('accepts cues ending %s seconds into a 100-second part only within the tolerance', async (end, expected) => {
    const { dom, fetch, capture } = page(address, false)
    fetch.mockResolvedValueOnce(json(videoMetadata(100, 100))).mockResolvedValueOnce(json(nav()))
      .mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(bodyTo(end)))
    try { expect(await capture()).toMatchObject(expected) }
    finally { dom.window.close() }
  })

  it.each(['123', '000123'])('uses numeric aid %s for av identity and checks it before selecting the current part', async aid => {
    const { dom, fetch, capture } = page(`https://bilibili.com/video/av${aid}/?p=2`)
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
    try {
      expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' })
      expect(fetch.mock.calls[0]?.[0]).toBe(`https://api.bilibili.com/x/web-interface/view?aid=${aid}`)
      expect(fetch.mock.calls[2]?.[0]).toMatch(playerInfo)
      expect(fetch).toHaveBeenCalledTimes(4)
    } finally { dom.window.close() }
  })

  it('accepts a protocol-relative allowlisted JSON track without exposing its signed query', async () => {
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(metadata([track(cdn.replace('https:', ''))]))).mockResolvedValueOnce(json(body()))
    try { expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' }); expect(fetch.mock.calls[3]?.[0]).toBe(cdn) }
    finally { dom.window.close() }
  })

  it.each([51, 58])('accepts only the evidenced no-extension AI basename of generated length %s', async length => {
    const { dom, fetch, capture } = page()
    const target = `https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${'a'.repeat(length)}?auth_key=generated-sensitive-key`
    fetch.mockResolvedValueOnce(json(metadata([track(target)]))).mockResolvedValueOnce(json(body()))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleStatus: 'loaded', coverage: 'loaded' })
      expect(reply).not.toHaveProperty('subtitleDiagnostic')
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(fetch.mock.calls[3]?.[0]).toBe(target)
      expect(fetch.mock.calls[3]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error' })
      expect(JSON.stringify(reply)).not.toMatch(/auth_key|generated-sensitive-key|aisubtitle\.hdslb/)
    } finally { dom.window.close() }
  })

  it.each([
    'https://other.hdslb.com/bfs/ai_subtitle/prod/abcdef',
    'https://aisubtitle.hdslb.com/bfs/subtitle/prod/abcdef',
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/abcdef',
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/ABCDEF',
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/generated',
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/ab_cd',
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/abc/def',
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/abcdef.mp4',
    'https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/abcdef.m4s',
  ])('does not widen no-extension approval beyond the exact AI host and path: %s', async target => {
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(metadata([track(target)])))
    try {
      expect(await capture()).toMatchObject({ subtitleReason: 'request-failed', subtitleDiagnostic: { stage: 'subtitle-info', failure: 'address', httpStatus: 200, apiCode: 0 } })
      expect(fetch).toHaveBeenCalledTimes(3)
    } finally { dom.window.close() }
  })

  it.each(['https://i0.hdslb.com/bfs/subtitle/generated.json', cdn])('retains the previous explicit JSON path rule: %s', async target => {
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(metadata([track(target)]))).mockResolvedValueOnce(json(body()))
    try { expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' }); expect(fetch).toHaveBeenCalledTimes(4) }
    finally { dom.window.close() }
  })

  it.each(['invalid-json', 'invalid-cue'])('requires valid subtitle JSON and cues even for approved no-extension URLs: %s', async scenario => {
    const { dom, fetch, capture } = page()
    const target = `https://aisubtitle.hdslb.com/bfs/ai_subtitle/prod/${'b'.repeat(58)}?auth_key=generated-sensitive-key`
    fetch.mockResolvedValueOnce(json(metadata([track(target)]))).mockResolvedValueOnce(scenario === 'invalid-json'
      ? new Response('generated-sensitive-response-body') : json({ body: [{ from: 2, to: 1, content: 'generated-sensitive-content' }] }))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleStatus: 'not-loaded', subtitleReason: 'request-failed', subtitleDiagnostic: { stage: 'subtitle-file', failure: scenario === 'invalid-json' ? 'json' : 'shape', httpStatus: 200 } })
      expect(JSON.stringify(reply)).not.toMatch(/auth_key|generated-sensitive|aisubtitle\.hdslb/)
      expect(fetch).toHaveBeenCalledTimes(4)
    } finally { dom.window.close() }
  })

  it.each(['missing', 'stale', 'throwing', 'nested-throwing'])('never reads global page state, even when it is %s', async scenario => {
    const { dom, fetch, capture } = page()
    const forbidden = vi.fn(() => { throw new Error('Global state must not be read') })
    if (scenario === 'stale') Reflect.set(dom.window, '__INITIAL_STATE__', { bvid: 'BV0000000000', aid: 456, cid: 1, p: 1 })
    if (scenario === 'throwing') Object.defineProperty(dom.window, '__INITIAL_STATE__', { get: forbidden })
    if (scenario === 'nested-throwing') Reflect.set(dom.window, '__INITIAL_STATE__', Object.defineProperty({}, 'videoData', { get: forbidden }))
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
    try {
      expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' })
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(forbidden).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it.each([
    { bvid: 'BV0000000000', aid: 123, pages: [{ page: 2, cid: 202 }] },
    { bvid, aid: 0, pages: [{ page: 2, cid: 202 }] },
    { bvid, aid: 123, pages: [] },
    { bvid, aid: 123, pages: [{ page: 1, cid: 101 }] },
    { bvid, aid: 123, pages: [{ page: 2, cid: 0 }] },
    { bvid, aid: 123, pages: [{ page: 2, cid: 202 }, { page: 2, cid: 202 }] },
    { bvid, aid: 123, pages: 'invalid' },
    {},
  ])('does not request signing keys or player metadata when the public identity or target part is unconfirmed: %j', async data => {
    const { dom, fetch, capture } = page(address, false)
    fetch.mockResolvedValueOnce(json({ code: 0, data }))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleStatus: 'not-loaded', subtitleReason: 'not-available' })
      if (!('kind' in reply)) throw new Error('Expected metadata')
      expect(reply.text).toContain('Current video/part identity not confirmed; subtitle file not requested.')
      expect(reply.text).toContain('Title: Generated title😀')
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally { dom.window.close() }
  })

  it('rejects a mismatched av identity without issuing a signing key request', async () => {
    const { dom, fetch, capture } = page('https://bilibili.com/video/av456/?p=2')
    try { expect(await capture()).toMatchObject({ subtitleReason: 'not-available' }); expect(fetch).toHaveBeenCalledTimes(1) }
    finally { dom.window.close() }
  })

  it.each(['?p=2&p=2', '?p=0', '?p=2.1', '?p=bad'])('rejects an invalid part before any request: %s', async query => {
    const { dom, fetch, capture } = page(`https://www.bilibili.com/video/${bvid}/${query}`)
    try { expect(await capture()).toMatchObject({ subtitleReason: 'not-available' }); expect(fetch).not.toHaveBeenCalled() }
    finally { dom.window.close() }
  })

  it.each(['', '?p=1'])('selects only the public API first-part CID when the URL selects part one: %s', async query => {
    const { dom, fetch, capture } = page(`https://www.bilibili.com/video/${bvid}/${query}`)
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
    try {
      expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' })
      expect(fetch.mock.calls[2]?.[0]).toMatch(/aid=123&cid=101&wts=\d{10}&w_rid=[0-9a-f]{32}$/)
      expect(fetch).toHaveBeenCalledTimes(4)
    } finally { dom.window.close() }
  })

  it.each([1, 2, 3])('does not issue a subsequent request after navigation during request %s', async stage => {
    const { dom, fetch, capture } = page(address, false)
    const reconfigure = () => dom.reconfigure({ url: `https://www.bilibili.com/video/${bvid}/?p=1` })
    const responses = [() => json(videoMetadata()), () => json(nav()), () => json(metadata())]
    for (let index = 0; index < stage; index += 1) {
      const respond = responses[index]
      fetch.mockImplementationOnce(index === stage - 1 ? async () => { reconfigure(); return respond() } : respond)
    }
    try { expect(await capture()).toMatchObject({ subtitleReason: 'not-available' }); expect(fetch).toHaveBeenCalledTimes(stage) }
    finally { dom.window.close() }
  })

  it('uses zero requests when standard browser cues are already loaded', async () => {
    const { dom, fetch, capture } = page()
    const wrap = dom.window.document.createElement('div')
    wrap.className = 'bpx-player-video-wrap'
    const video = dom.window.document.createElement('video')
    wrap.append(video)
    dom.window.document.body.append(wrap)
    Object.defineProperty(video, 'textTracks', { value: [{ kind: 'captions', mode: 'hidden', cues: [{ startTime: 1, endTime: 2, text: 'Generated standard cue' }] }] })
    try { expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' }); expect(fetch).not.toHaveBeenCalled() }
    finally { dom.window.close() }
  })

  it('stops login, access, HTTP, and malformed-response errors at the video identity request', async () => {
    for (const [value, status, reason] of [
      [{ code: -101 }, 200, 'login-required'],
      [{ code: -403 }, 200, 'access-denied'],
      [{ code: -412 }, 200, 'access-denied'],
      [{ code: 42 }, 200, 'request-failed'],
      [{}, 403, 'access-denied'],
      [{}, 412, 'access-denied'],
      [{}, 500, 'request-failed'],
    ] as const) {
      const { dom, fetch, capture } = page(address, false)
      fetch.mockResolvedValueOnce(json(value, status))
      try {
        const reply = await capture()
        expect(reply).toMatchObject({ subtitleStatus: 'not-loaded', subtitleReason: reason })
        expect(fetch).toHaveBeenCalledTimes(1)
        if (!('kind' in reply)) throw new Error('Expected metadata')
        expect(reply.text).toContain('Title: Generated title😀')
        expect(reply.text).toContain('No ASR was performed')
      } finally { dom.window.close() }
    }
  })

  it('stops HTTP and malformed-response errors at the signing key request', async () => {
    for (const response of [json({}, 403), json({}, 412), json({}, 500), new Response('generated-invalid-json'), new Response('{}', { status: 302 })]) {
      const { dom, fetch, capture } = page(address, false)
      fetch.mockResolvedValueOnce(json(videoMetadata())).mockResolvedValueOnce(response)
      try {
        const reply = await capture()
        expect(reply).toMatchObject({ subtitleStatus: 'not-loaded', subtitleReason: response instanceof Response && [403, 412].includes(response.status) ? 'access-denied' : 'request-failed' })
        expect(fetch).toHaveBeenCalledTimes(2)
        expect(JSON.stringify(reply)).not.toContain('generated-invalid-json')
      } finally { dom.window.close() }
    }
  })

  it.each([
    [{ code: -101 }, 'login-required'],
    [{ code: -403 }, 'access-denied'],
    [{ code: -412 }, 'access-denied'],
    [{ code: 42 }, 'request-failed'],
  ] as const)('stops API code %j at the signed player info request', async (value, reason) => {
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(value))
    try {
      expect(await capture()).toMatchObject({ subtitleStatus: 'not-loaded', subtitleReason: reason })
      expect(fetch).toHaveBeenCalledTimes(3)
    } finally { dom.window.close() }
  })

  it.each([
    [metadata([]), 'not-provided'],
    [{ code: 0, data: { need_login_subtitle: true, subtitle: { subtitles: [] } } }, 'login-required'],
    [{ code: 0, data: {} }, 'request-failed'],
    [{ code: 0, data: { subtitle: { subtitles: 'invalid' } } }, 'request-failed'],
  ])('stops after unavailable or malformed signed player tracks: %j', async (value, reason) => {
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(value))
    try { expect(await capture()).toMatchObject({ subtitleReason: reason }); expect(fetch).toHaveBeenCalledTimes(3) }
    finally { dom.window.close() }
  })

  it('fails closed when the site stops publishing signing keys', async () => {
    const { dom, fetch, capture } = page(address, false)
    fetch.mockResolvedValueOnce(json(videoMetadata())).mockResolvedValueOnce(json({ code: 0, data: {} }))
    try {
      expect(await capture()).toMatchObject({ subtitleReason: 'request-failed', subtitleDiagnostic: { stage: 'subtitle-info', failure: 'shape', httpStatus: 200 } })
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally { dom.window.close() }
  })

  it.each(['sub_url', 'img_sub_url'])('signs with the current and the earlier second-key field name: %s', async subField => {
    const { dom, fetch, capture } = page(address, false)
    fetch.mockResolvedValueOnce(json(videoMetadata())).mockResolvedValueOnce(json(nav(subField)))
      .mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
    try {
      expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' })
      expect(fetch.mock.calls[2]?.[0]).toMatch(playerInfo)
    } finally { dom.window.close() }
  })

  it('still reads the player-requested file when signing keys are unavailable', async () => {
    const { dom, fetch, capture } = page(address, false)
    withPlayerResource(dom, playerTrack)
    fetch.mockResolvedValueOnce(json(videoMetadata())).mockResolvedValueOnce(json({ code: 0, data: {} })).mockResolvedValueOnce(json(body()))
    try {
      expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' })
      expect(fetch).toHaveBeenCalledTimes(3)
      expect(fetch.mock.calls[2]?.[0]).toBe(playerTrack)
    } finally { dom.window.close() }
  })

  it.each(['http://aisubtitle.hdslb.com/bfs/subtitle/a.json', 'https://aisubtitle.hdslb.com.evil.test/bfs/subtitle/a.json', 'https://evil.test/bfs/subtitle/a.json', 'https://hdslb.com/bfs/subtitle/a.json', 'https://user@aisubtitle.hdslb.com/bfs/subtitle/a.json', 'https://aisubtitle.hdslb.com:443/bfs/subtitle/a.json', 'https://aisubtitle.hdslb.com/bfs/audio/a.m4s', 'https://aisubtitle.hdslb.com/bfs/subtitle/a.mp4', 'https://aisubtitle.hdslb.com/other/a.json', 'https://aisubtitle.hdslb.com/bfs/subtitle/a.json#fragment'])('never requests an unapproved resource or audio/video URL: %s', async target => {
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(metadata([track(target)])))
    try { expect(await capture()).toMatchObject({ subtitleReason: 'request-failed' }); expect(fetch).toHaveBeenCalledTimes(3) }
    finally { dom.window.close() }
  })

  it('ignores player resource entries outside the subtitle allowlist', async () => {
    const { dom, fetch, capture } = page()
    withPlayerResource(dom, 'https://example.test/subtitle.json')
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
    try {
      expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' })
      expect(fetch).toHaveBeenCalledTimes(4)
      expect(fetch.mock.calls[3]?.[0]).toBe(cdn)
    } finally { dom.window.close() }
  })

  it.each([{ body: [] }, {}, { body: 'invalid' }, { body: [{ from: -1, to: 2, content: 'Generated' }] }, { body: [{ from: 2, to: 1, content: 'Generated' }] }, { body: [{ from: '1', to: 2, content: 'Generated' }] }, { body: [{ from: 1, to: 2, content: 3 }] }, { body: [{ from: 1, to: 2, content: ' ' }] }])('rejects malformed subtitle JSON instead of claiming absent subtitles: %j', async value => {
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(value))
    try { expect(await capture()).toMatchObject({ subtitleReason: 'request-failed' }); expect(fetch).toHaveBeenCalledTimes(4) }
    finally { dom.window.close() }
  })

  it.each([403, 412, 500])('stops on subtitle HTTP %s', async status => {
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json({}, status))
    try { expect(await capture()).toMatchObject({ subtitleReason: status === 500 ? 'request-failed' : 'access-denied' }); expect(fetch).toHaveBeenCalledTimes(4) }
    finally { dom.window.close() }
  })

  it('contains malformed JSON at the video identity request without retry', async () => {
    const { dom, fetch, capture } = page(address, false)
    fetch.mockResolvedValueOnce(new Response('generated-invalid-json'))
    try { expect(await capture()).toMatchObject({ subtitleReason: 'request-failed' }); expect(fetch).toHaveBeenCalledTimes(1) }
    finally { dom.window.close() }
  })

  it('contains a first-request network or CORS failure without retry or leaking its error', async () => {
    const { dom, fetch, capture } = page(address, false)
    fetch.mockRejectedValueOnce(new TypeError('generated-sensitive-request-error'))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleReason: 'request-failed' })
      expect(JSON.stringify(reply)).not.toContain('generated-sensitive-request-error')
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally { dom.window.close() }
  })

  it('rejects non-finite subtitle timestamps parsed from JSON', async () => {
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(new Response('{"body":[{"from":1e999,"to":1e999,"content":"Generated cue"}]}'))
    try { expect(await capture()).toMatchObject({ subtitleReason: 'request-failed' }) }
    finally { dom.window.close() }
  })

  it('does not expose rejected request targets or fetch errors and does not try another track', async () => {
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(metadata([track(), track('https://aisubtitle.hdslb.com/bfs/subtitle/other.json')]))).mockRejectedValueOnce(new Error(cdn))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleReason: 'request-failed' })
      expect(JSON.stringify(reply)).not.toMatch(/auth_key|generated-sensitive-key|hdslb\.com/)
      expect(fetch).toHaveBeenCalledTimes(4)
    } finally { dom.window.close() }
  })

  it.each([1, 2, 3, 4, 5])('uses one total timeout, aborts and clears its timer when request %s never settles', async stage => {
    vi.useFakeTimers()
    const { dom, fetch, capture } = page(address, false)
    if (stage >= 2) withPlayerResource(dom, stage === 5 ? playerTrack : playerTrack)
    if (stage >= 2) fetch.mockResolvedValueOnce(json(videoMetadata()))
    if (stage >= 3) fetch.mockResolvedValueOnce(json(nav()))
    if (stage >= 4) fetch.mockResolvedValueOnce(json(metadata()))
    if (stage >= 5) fetch.mockResolvedValueOnce(json({}, 500))
    fetch.mockImplementationOnce(() => new Promise(() => {}))
    try {
      const result = capture(65536, 25)
      await vi.advanceTimersByTimeAsync(25)
      const reply = await result
      expect(reply).toMatchObject({ subtitleReason: 'timeout' })
      if (!('kind' in reply) || reply.subtitleStatus !== 'not-loaded') throw new Error('Expected unavailable subtitles')
      expect(reply.subtitleDiagnostic).toEqual({ stage: stage === 1 ? 'video-info' : stage <= 3 ? 'subtitle-info' : 'subtitle-file', failure: 'network' })
      expect(fetch).toHaveBeenCalledTimes(stage)
      expect(fetch.mock.calls[stage - 1]?.[1]?.signal?.aborted).toBe(true)
      expect(vi.getTimerCount()).toBe(0)
    } finally { dom.window.close() }
  })

  it('clears the timeout and aborts its operation signal after successful requests', async () => {
    vi.useFakeTimers()
    const { dom, fetch, capture } = page()
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
    try {
      expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' })
      expect(vi.getTimerCount()).toBe(0)
      expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    } finally { dom.window.close() }
  })

  it.each([1, 2, 3, 4])('cancels an oversized stream at request %s without retry or later requests', async stage => {
    const { dom, fetch, capture } = page(address, false)
    const cancel = vi.fn()
    let sent = false
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { if (!sent) { controller.enqueue(new Uint8Array(stage <= 3 ? 4194305 : 65537)); sent = true } }, cancel })
    if (stage >= 2) fetch.mockResolvedValueOnce(json(videoMetadata()))
    if (stage >= 3) fetch.mockResolvedValueOnce(json(nav()))
    if (stage >= 4) fetch.mockResolvedValueOnce(json(metadata([track(), track('https://aisubtitle.hdslb.com/bfs/subtitle/second.json')])))
    fetch.mockResolvedValueOnce(new Response(stream))
    try { expect(await capture()).toEqual({ code: 'too-large' }); expect(cancel).toHaveBeenCalledTimes(1); expect(fetch).toHaveBeenCalledTimes(stage) }
    finally { dom.window.close() }
  })

  it('reads collection-sized metadata responses above the reply budget', async () => {
    const { dom, fetch, capture } = page(address, false)
    fetch.mockResolvedValueOnce(json({ ...videoMetadata(), pad: 'g'.repeat(150000) })).mockResolvedValueOnce(json(nav()))
      .mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
    try { expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' }); expect(fetch).toHaveBeenCalledTimes(4) }
    finally { dom.window.close() }
  })

  it('enforces complete enriched UTF-8 JSON bytes without truncating title, URL, language, or cues', async () => {
    const { dom, fetch, capture } = page()
    try {
      fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
      const expected = await capture()
      const bytes = new TextEncoder().encode(JSON.stringify(expected)).byteLength
      fetch.mockResolvedValueOnce(json(videoMetadata())).mockResolvedValueOnce(json(nav())).mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
      expect(await capture(bytes)).toEqual(expected)
      fetch.mockResolvedValueOnce(json(videoMetadata())).mockResolvedValueOnce(json(nav())).mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
      expect(await capture(bytes - 1)).toEqual({ code: 'too-large' })
    } finally { dom.window.close() }
  })

  it('does not read global state, cookie values, storage, player getters or clipboard, execute scripts, or mutate DOM', async () => {
    const { dom, fetch, capture } = page()
    const forbidden = vi.fn(() => { throw new Error('Generated forbidden access') })
    for (const key of ['__INITIAL_STATE__', 'localStorage', 'sessionStorage', 'player', '__playinfo__']) Object.defineProperty(dom.window, key, { get: forbidden })
    Object.defineProperty(dom.window.document, 'cookie', { get: forbidden })
    Object.defineProperty(dom.window.navigator, 'clipboard', { get: forbidden })
    fetch.mockResolvedValueOnce(json(metadata())).mockResolvedValueOnce(json(body()))
    const before = dom.serialize()
    const observer = new dom.window.MutationObserver(forbidden)
    observer.observe(dom.window.document, { subtree: true, childList: true, attributes: true, characterData: true })
    try {
      expect(await capture()).toMatchObject({ subtitleStatus: 'loaded' })
      expect(dom.serialize()).toBe(before)
      expect(observer.takeRecords()).toEqual([])
      expect(forbidden).not.toHaveBeenCalled()
    } finally { observer.disconnect(); dom.window.close() }
  })

  it.each(['video-info', 'subtitle-info', 'subtitle-file'])('reports only the current safe stage for network, HTTP and JSON failures at %s', async stage => {
    for (const failure of ['network', 'http', 'json'] as const) {
      const { dom, fetch, capture } = page(address, stage !== 'video-info')
      if (stage === 'subtitle-file') fetch.mockResolvedValueOnce(json(metadata()))
      if (failure === 'network') fetch.mockRejectedValueOnce(new Error(`${cdn} generated-cookie-value generated-body-value`))
      else fetch.mockResolvedValueOnce(failure === 'http' ? json({}, 503) : new Response('generated-body-value'))
      try {
        const reply = await capture()
        const expected = { stage, failure, ...(failure === 'network' ? {} : { httpStatus: failure === 'http' ? 503 : 200 }) }
        expect(reply).toMatchObject({ subtitleStatus: 'not-loaded', subtitleReason: 'request-failed' })
        if (!('kind' in reply) || reply.subtitleStatus !== 'not-loaded') throw new Error('Expected unavailable subtitles')
        expect(reply.subtitleDiagnostic).toEqual(expected)
        expect(JSON.stringify(reply)).not.toMatch(/auth_key|generated-sensitive-key|generated-cookie-value|generated-body-value|aisubtitle\.hdslb/)
        expect(fetch).toHaveBeenCalledTimes(stage === 'video-info' ? 1 : stage === 'subtitle-info' ? 3 : 4)
      } finally { dom.window.close() }
    }
  })

  it.each(['video-info', 'subtitle-info'])('records bounded numeric API codes only at %s', async stage => {
    for (const code of [-101, -403, -412, -2147483648, 2147483647, 'generated-sensitive-api-code', 2147483648, -2147483649, 1.5, null]) {
      const { dom, fetch, capture } = page(address, stage === 'subtitle-info')
      fetch.mockResolvedValueOnce(json({ code }))
      try {
        const reply = await capture()
        const numeric = typeof code === 'number' && Number.isInteger(code) && code >= -2147483648 && code <= 2147483647
        const subtitleReason = code === -101 ? 'login-required' : code === -403 || code === -412 ? 'access-denied' : 'request-failed'
        expect(reply).toMatchObject({ subtitleReason })
        if (!('kind' in reply) || reply.subtitleStatus !== 'not-loaded') throw new Error('Expected unavailable subtitles')
        expect(reply.subtitleDiagnostic).toEqual({ stage, failure: 'api', httpStatus: 200, ...(numeric ? { apiCode: code } : {}) })
        expect(JSON.stringify(reply)).not.toContain('generated-sensitive-api-code')
      } finally { dom.window.close() }
    }
  })

  it.each(['subtitle-info', 'subtitle-file'])('reports HTTP access failures without retaining a previous API code at %s', async stage => {
    const { dom, fetch, capture } = page()
    if (stage === 'subtitle-file') fetch.mockResolvedValueOnce(json(metadata()))
    fetch.mockResolvedValueOnce(json({}, 403))
    try {
      const reply = await capture()
      expect(reply).toMatchObject({ subtitleReason: 'access-denied' })
      if (!('kind' in reply) || reply.subtitleStatus !== 'not-loaded') throw new Error('Expected unavailable subtitles')
      expect(reply.subtitleDiagnostic).toEqual({ stage, failure: 'http', httpStatus: 403 })
    } finally { dom.window.close() }
  })

  it.each(['subtitle-info', 'subtitle-file'])('reports shape failures at %s with only that response metadata', async stage => {
    const { dom, fetch, capture } = page()
    if (stage === 'subtitle-file') fetch.mockResolvedValueOnce(json(metadata()))
    fetch.mockResolvedValueOnce(json(stage === 'subtitle-info' ? { code: 0, data: {} } : { body: 'generated-sensitive-body' }))
    try {
      const reply = await capture()
      if (!('kind' in reply) || reply.subtitleStatus !== 'not-loaded') throw new Error('Expected unavailable subtitles')
      expect(reply.subtitleReason).toBe('request-failed')
      expect(reply.subtitleDiagnostic).toEqual({ stage, failure: 'shape', httpStatus: 200, ...(stage === 'subtitle-info' ? { apiCode: 0 } : {}) })
      expect(JSON.stringify(reply)).not.toContain('generated-sensitive-body')
    } finally { dom.window.close() }
  })

  it('does not attach diagnostics to absent tracks or unconfirmed identity', async () => {
    for (const [response, reason] of [[videoMetadata(), 'not-provided'], [{ code: 0, data: {} }, 'not-available']] as const) {
      const { dom, fetch, capture } = page(address, false)
      fetch.mockResolvedValueOnce(json(response))
      if (reason === 'not-provided') fetch.mockResolvedValueOnce(json(nav())).mockResolvedValueOnce(json(metadata([])))
      try {
        const reply = await capture()
        expect(reply).toMatchObject({ subtitleReason: reason })
        expect(reply).not.toHaveProperty('subtitleDiagnostic')
      } finally { dom.window.close() }
    }
  })

  it('budgets diagnostic fields as part of the complete UTF-8 JSON response', async () => {
    const { dom, fetch, capture } = page(address, false)
    try {
      fetch.mockResolvedValueOnce(json({ code: -101 }))
      const expected = await capture()
      const bytes = new TextEncoder().encode(JSON.stringify(expected)).byteLength
      fetch.mockResolvedValueOnce(json({ code: -101 }))
      expect(await capture(bytes)).toEqual(expected)
      fetch.mockResolvedValueOnce(json({ code: -101 }))
      expect(await capture(bytes - 1)).toEqual({ code: 'too-large' })
    } finally { dom.window.close() }
  })

  it('does not start requests for a tiny budget or a missing video title', async () => {
    const { dom, fetch, capture } = page()
    try {
      expect(await capture(1)).toEqual({ code: 'too-large' })
      dom.window.document.querySelector('h1')?.remove()
      expect(await capture()).toEqual({ code: 'no-video' })
      expect(fetch).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })
})

describe('site request signing helpers', () => {
  it('computes RFC 1321 MD5 over UTF-8 input', () => {
    for (const value of ['', 'abc', 'The quick brown fox jumps over the lazy dog', '中文😀'.repeat(7), 'x'.repeat(1000)]) {
      expect(md5Hex(value)).toBe(createHash('md5').update(value, 'utf8').digest('hex'))
    }
  })

  it('derives the rotation signing key with the published permutation', () => {
    expect(mixin).toBe('5c1da195a33c00e1584b737c1e4245b8')
    expect(mixin).toHaveLength(32)
  })

  it('builds the sorted signed query with wts and w_rid', () => {
    const query = wbiSignedQuery({ cid: '202', aid: '123' }, mixin, 1700000000, md5Hex)
    const base = 'aid=123&cid=202&wts=1700000000'
    expect(query).toBe(`${base}&w_rid=${createHash('md5').update(`${base}${mixin}`, 'utf8').digest('hex')}`)
  })

  it('drops site-excluded characters from parameter values before signing', () => {
    const query = wbiSignedQuery({ z: "a!'()*b" }, mixin, 1, md5Hex)
    expect(query).toMatch(/^z=ab&wts=1&w_rid=[0-9a-f]{32}$/)
  })
})

describe('subtitle reason IPC fields', () => {
  const valid = { kind: 'video', url: address, title: 'Generated title', text: 'Generated metadata', format: 'text', coverage: 'loaded', subtitleStatus: 'not-loaded' }
  it.each(['not-available', 'not-provided', 'login-required', 'access-denied', 'request-failed', 'timeout'])('projects the known not-loaded reason %s', subtitleReason => {
    expect(decodeBilibiliReply({ ...valid, subtitleReason, ignored: 'generated' })).toEqual({ ...valid, subtitleReason })
  })
  it.each([{ ...valid, subtitleReason: 'unexpected' }, { ...valid, subtitleReason: null }, { ...valid, subtitleStatus: 'loaded', subtitleReason: 'timeout' }])('rejects malformed reason/status combinations', value => {
    expect(() => decodeBilibiliReply(value)).toThrowError(new Error('Invalid Bilibili reply'))
  })
})
