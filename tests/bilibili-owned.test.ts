// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { runInContext, runInNewContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { bilibiliVideoScript, decodeBilibiliReply, isBilibiliVideo } from '../src/readers/bilibili.ts'

const url = 'https://www.bilibili.com/video/BV1qStU63ERs/?p=2&spm_id_from=generated&vd_source=generated'
// Root/class relationships observed in public https://www.bilibili.com/video/BV1qStU63ERs/ HTML.
// Text is generated. Public core.a3c25289.js confirms an overlay, not a transcript list template.
const metadata = '<div id="viewbox_report" class="video-info-container"><h1 class="video-title">Generated 标题😀</h1></div><div class="up-info-container"><a class="up-name">Generated uploader</a></div><div id="v_desc" class="video-desc-container"><span class="desc-info-text">Generated description<br>Second generated line</span></div>'

function page(html = metadata, address = url) {
  const dom = new JSDOM(html, { url: address, runScripts: 'outside-only' })
  Reflect.set(dom.window, 'TextEncoder', TextEncoder)
  const capture = (budget = 65536) => decodeBilibiliReply(runInContext(bilibiliVideoScript(budget), dom.getInternalVMContext()))
  return { dom, capture }
}

describe('read-only Bilibili video page snapshots', () => {
  it('accepts only supported credential-free HTTPS video addresses without explicit ports', () => {
    for (const address of [url, 'https://bilibili.com/video/av123/', 'https://www.bilibili.com/video/BV1qStU63ERs']) expect(isBilibiliVideo(address)).toBe(true)
    for (const address of ['invalid', 'http://www.bilibili.com/video/BV1qStU63ERs/', 'https://www.bilibili.com.evil.test/video/BV1qStU63ERs/', 'https://user@www.bilibili.com/video/BV1qStU63ERs/', 'https://www.bilibili.com:443/video/BV1qStU63ERs/', 'https://www.bilibili.com:444/video/BV1qStU63ERs/', 'https://m.bilibili.com/video/BV1qStU63ERs/', 'https://www.bilibili.com/video/BVshort/', 'https://www.bilibili.com/video/avabc/', 'https://www.bilibili.com/video/BV1qStU63ERs/extra', 'https://www.bilibili.com/bangumi/play/ep123']) expect(isBilibiliVideo(address)).toBe(false)
  })

  it('reads fixed current-video metadata and preserves the exact loaded URL', () => {
    const { dom, capture } = page(`${metadata}<aside><h1 class="video-title">recommendation-secret</h1><a class="up-name">sidebar-secret</a></aside><div id="comments">comment-secret</div>`)
    try {
      const reply = capture()
      expect(reply).toMatchObject({ kind: 'video', url, title: 'Generated 标题😀', format: 'text', coverage: 'loaded', subtitleStatus: 'not-loaded' })
      if (!('kind' in reply)) throw new Error('Expected page information')
      expect(reply.text).toContain('Title: Generated 标题😀\nUploader: Generated uploader\nDescription: Generated description\nSecond generated line')
      expect(reply.text).toContain('not audio/video understanding')
      expect(reply.text).toContain('already loaded standard browser subtitle cues')
      expect(reply.text).toContain('completeness is not verified')
      expect(reply.text).toContain('Check whether subtitles are enabled and accessible on the website before retrying')
      expect(reply.text).not.toContain('Open an accessible subtitle list')
      expect(reply.text).toContain('No ASR was performed')
      expect(reply.text).not.toMatch(/recommendation-secret|sidebar-secret|comment-secret/)
    } finally { dom.window.close() }
  })

  it('reports missing optional metadata without replacing it with sidebar or document text', () => {
    const { dom, capture } = page('<title>Generated tab name</title><div id="viewbox_report" class="video-info-container"><h1 class="video-title">Generated title</h1></div><a class="up-name">unscoped-secret</a><span class="desc-info-text">unscoped-secret</span>')
    try {
      const reply = capture()
      if (!('kind' in reply)) throw new Error('Expected page information')
      expect(reply.text).toContain('Uploader: [missing]\nDescription: [missing]')
      expect(reply.text).not.toContain('unscoped-secret')
    } finally { dom.window.close() }
  })

  it.each(['hidden', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"', 'style="visibility:collapse"', 'style="opacity:0"'])('ignores hidden descendants and metadata on hidden ancestors: %s', attribute => {
    const { dom, capture } = page(`<div ${attribute}><div class="up-info-container"><a class="up-name">hidden-uploader</a></div></div><div id="viewbox_report" class="video-info-container"><h1 class="video-title">Generated title<span ${attribute}>hidden-title</span></h1></div><div id="v_desc" class="video-desc-container"><span class="desc-info-text">Visible description<span ${attribute}>hidden-description</span><script>hidden-script</script></span></div>`)
    try {
      const reply = capture()
      if (!('kind' in reply)) throw new Error('Expected page information')
      expect(reply.title).toBe('Generated title')
      expect(reply.text).toContain('Uploader: [missing]')
      expect(reply.text).not.toMatch(/hidden-uploader|hidden-title|hidden-description|hidden-script/)
    } finally { dom.window.close() }
  })

  it.each([
    '',
    '<title>安全验证</title>',
    `<title>安全验证</title>${metadata}`,
    '<h1 class="video-title">unscoped-title</h1>',
    '<div hidden><div id="viewbox_report" class="video-info-container"><h1 class="video-title">hidden-title</h1></div></div>',
  ])('rejects missing, hidden or challenge page title roots', html => {
    const { dom, capture } = page(html)
    try { expect(capture()).toEqual({ code: 'no-video' }) }
    finally { dom.window.close() }
  })

  it.each(['https://www.bilibili.com.evil.test/video/BV1qStU63ERs/', 'https://www.bilibili.com/read/cv123', 'http://www.bilibili.com/video/BV1qStU63ERs/'])('rejects a guest page on an unsupported host/path: %s', address => {
    const { dom, capture } = page(metadata, address)
    try { expect(capture()).toEqual({ code: 'no-video' }) }
    finally { dom.window.close() }
  })

  it.each(['', 'hidden', 'aria-hidden="true"', 'style="display:none"', 'style="visibility:hidden"', 'style="opacity:0"'])('never treats the evidenced current-cue overlay as a loaded subtitle list: %s', attribute => {
    const { dom, capture } = page(`${metadata}<div ${attribute}><div class="bpx-player-subtitle-wrap">00:03 generated-cue-secret</div></div><div id="comments"><div role="list"><div role="listitem">00:04 generated-comment-secret</div></div></div>`)
    try {
      const reply = capture()
      expect(reply).toMatchObject({ kind: 'video', subtitleStatus: 'not-loaded' })
      if (!('kind' in reply)) throw new Error('Expected page information')
      expect(reply.text).not.toMatch(/generated-cue-secret|generated-comment-secret|00:03|00:04/)
    } finally { dom.window.close() }
  })

  it.each(['showing', 'hidden'])('reads only already loaded standard subtitle cues in existing order, without changing track mode: %s', mode => {
    const { dom, capture } = page(`${metadata}<div class="bpx-player-video-wrap"><video></video></div>`)
    const video = dom.window.document.querySelector('video')
    if (!video) throw new Error('Expected generated video')
    const forbidden = vi.fn(() => { throw new Error('Track activation is forbidden') })
    const track = {
      kind: 'subtitles',
      get mode() { return mode },
      set mode(_value: string) { forbidden() },
      cues: [{ startTime: 12.25, endTime: 13.5, text: 'Generated later cue' }, { startTime: 1, endTime: 2, text: 'Generated earlier cue😀' }],
      get activeCues() { return forbidden() },
    }
    Object.defineProperty(video, 'textTracks', { value: [track] })
    try {
      const reply = capture()
      expect(reply).toMatchObject({ kind: 'video', subtitleStatus: 'loaded' })
      if (!('kind' in reply)) throw new Error('Expected page information')
      expect(reply.text).toContain('[12.250s --> 13.500s] Generated later cue\n[1.000s --> 2.000s] Generated earlier cue😀')
      expect(reply.text).toContain('currently loaded browser text-track cue list')
      expect(reply.text).toContain('completeness is not verified')
      expect(reply.text).toContain('No ASR was performed')
      const bytes = new TextEncoder().encode(JSON.stringify(reply)).byteLength
      expect(capture(bytes)).toEqual(reply)
      expect(capture(bytes - 1)).toEqual({ code: 'too-large' })
      expect(forbidden).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it.each(['disabled', 'descriptions', 'unloaded', 'empty', 'multiple-tracks', 'multiple-videos', 'hidden-video', 'outside-player'])('does not infer subtitle availability from ambiguous or inaccessible standard tracks: %s', scenario => {
    const video = '<video></video>'
    const markup = scenario === 'outside-player' ? video : `<div class="bpx-player-video-wrap" ${scenario === 'hidden-video' ? 'hidden' : ''}>${video}${scenario === 'multiple-videos' ? video : ''}</div>`
    const { dom, capture } = page(`${metadata}${markup}`)
    const forbidden = vi.fn(() => { throw new Error('Disabled cues must not be read') })
    const cues = [{ startTime: 0, endTime: 1, text: 'generated-unavailable-secret' }]
    const track = scenario === 'disabled'
      ? { kind: 'subtitles', mode: 'disabled', get cues() { return forbidden() } }
      : { kind: scenario === 'descriptions' ? 'descriptions' : 'captions', mode: 'showing', cues: scenario === 'unloaded' ? null : scenario === 'empty' ? [] : cues }
    for (const element of dom.window.document.querySelectorAll('video')) Object.defineProperty(element, 'textTracks', { value: scenario === 'multiple-tracks' ? [track, track] : [track] })
    try {
      const reply = capture()
      expect(reply).toMatchObject({ kind: 'video', subtitleStatus: 'not-loaded' })
      if (!('kind' in reply)) throw new Error('Expected page information')
      expect(reply.text).not.toContain('generated-unavailable-secret')
      expect(reply.text).toContain('this does not mean the video has no subtitles')
      expect(forbidden).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('does not fetch, click, execute page scripts, read player state, clipboard, cookies, or storage, or mutate DOM', () => {
    const { dom, capture } = page(`${metadata}<script>window.generatedPageRan=true</script>`)
    const forbidden = vi.fn(() => { throw new Error('Forbidden page operation') })
    for (const key of ['fetch', 'XMLHttpRequest', 'player', '__INITIAL_STATE__', '__playinfo__', 'localStorage', 'sessionStorage']) Object.defineProperty(dom.window, key, { configurable: true, get: forbidden })
    Object.defineProperty(dom.window.document, 'cookie', { configurable: true, get: forbidden })
    Object.defineProperty(dom.window.navigator, 'clipboard', { configurable: true, get: forbidden })
    const click = vi.spyOn(dom.window.HTMLElement.prototype, 'click').mockImplementation(forbidden)
    const observer = new dom.window.MutationObserver(forbidden)
    observer.observe(dom.window.document, { attributes: true, childList: true, characterData: true, subtree: true })
    const before = dom.serialize()
    try {
      expect(capture()).toMatchObject({ kind: 'video' })
      expect(dom.serialize()).toBe(before)
      expect(observer.takeRecords()).toEqual([])
      expect(Reflect.get(dom.window, 'generatedPageRan')).toBeUndefined()
      expect(forbidden).not.toHaveBeenCalled()
      expect(click).not.toHaveBeenCalled()
    } finally { observer.disconnect(); click.mockRestore(); dom.window.close() }
  })

  it('budgets the exact complete UTF-8 JSON result without truncation', () => {
    const { dom, capture } = page()
    try {
      const reply = capture()
      const bytes = new TextEncoder().encode(JSON.stringify(reply)).byteLength
      expect(bytes).toBeGreaterThan(JSON.stringify(reply).length)
      expect(capture(bytes)).toEqual(reply)
      expect(capture(bytes - 1)).toEqual({ code: 'too-large' })
      expect(capture(-1)).toEqual({ code: 'too-large' })
    } finally { dom.window.close() }
  })

  it.each([-1, 0, 1, 19])('returns a tiny-budget fixed control reply before accessing DOM: %s', budget => {
    const forbidden = vi.fn(() => { throw new Error('No DOM access allowed') })
    const context = Object.defineProperty({}, 'document', { get: forbidden })
    expect(runInNewContext(bilibiliVideoScript(budget), context)).toEqual({ code: 'too-large' })
    expect(forbidden).not.toHaveBeenCalled()
  })
})

describe('Bilibili IPC reply validation', () => {
  const valid = { kind: 'video', url, title: 'Generated title', text: 'Generated page information', format: 'text', coverage: 'loaded', subtitleStatus: 'not-loaded' }

  it.each(['loaded', 'not-loaded'])('projects successful owned fields with explicit subtitle status %s', subtitleStatus => {
    const expected = { ...valid, subtitleStatus }
    expect(decodeBilibiliReply({ ...expected, unowned: 'discarded' })).toEqual(expected)
    expect(decodeBilibiliReply(JSON.stringify({ ...expected, unowned: 'discarded' }))).toEqual(expected)
  })

  it.each(['no-video', 'too-large'])('projects fixed failure %s', code => {
    expect(decodeBilibiliReply({ code, extra: 'discarded' })).toEqual({ code })
  })

  it.each([null, undefined, [], 12, true, 'private-invalid-json', '{}', { code: 'unknown' }, { ...valid, kind: 'article' }, { ...valid, coverage: 'complete' }, { ...valid, subtitleStatus: 'complete' }, { ...valid, subtitleStatus: undefined }, { ...valid, title: '' }, { ...valid, text: '' }, { ...valid, url: 'https://evil.test/' }, { ...valid, format: 'markdown' }, { ...valid, title: 4 }])('rejects malformed unknown IPC without including its values', reply => {
    expect(() => decodeBilibiliReply(reply)).toThrowError(new Error('Invalid Bilibili reply'))
  })

  it.each(['video-info', 'subtitle-info', 'subtitle-file'])('projects only safe diagnostic fields at stage %s', stage => {
    for (const failure of ['network', 'http', 'api', 'json', 'shape', 'address']) {
      const diagnostic = { stage, failure, httpStatus: 200, apiCode: -101 }
      const reply = { ...valid, subtitleReason: 'request-failed', subtitleDiagnostic: diagnostic }
      const external = { ...reply, subtitleDiagnostic: { ...diagnostic, url: 'generated-sensitive-url', auth_key: 'generated-sensitive-signature', cookie: 'generated-sensitive-cookie', token: 'generated-sensitive-token', body: 'generated-sensitive-body' } }
      expect(decodeBilibiliReply(external)).toEqual(reply)
      expect(decodeBilibiliReply(JSON.stringify(external))).toEqual(reply)
      expect(JSON.stringify(decodeBilibiliReply(external))).not.toMatch(/generated-sensitive/)
    }
  })

  it.each([
    { stage: 'video-info', failure: 'network' },
    { stage: 'subtitle-info', failure: 'api', httpStatus: 0, apiCode: -2147483648 },
    { stage: 'subtitle-file', failure: 'http', httpStatus: 599, apiCode: 2147483647 },
  ])('accepts optional diagnostic values and inclusive numeric limits', subtitleDiagnostic => {
    const reply = { ...valid, subtitleReason: 'request-failed', subtitleDiagnostic }
    expect(decodeBilibiliReply(reply)).toEqual(reply)
  })

  it.each([
    null, [], true, 'generated-sensitive-diagnostic', {},
    { stage: 'unknown', failure: 'network' },
    { stage: 'video-info', failure: 'unknown' },
    { stage: 'video-info', failure: 'network', httpStatus: -1 },
    { stage: 'video-info', failure: 'network', httpStatus: 600 },
    { stage: 'video-info', failure: 'network', httpStatus: 1.5 },
    { stage: 'video-info', failure: 'network', httpStatus: '200' },
    { stage: 'video-info', failure: 'network', httpStatus: NaN },
    { stage: 'video-info', failure: 'network', httpStatus: Infinity },
    { stage: 'video-info', failure: 'network', httpStatus: null },
    { stage: 'subtitle-info', failure: 'api', apiCode: -2147483649 },
    { stage: 'subtitle-info', failure: 'api', apiCode: 2147483648 },
    { stage: 'subtitle-info', failure: 'api', apiCode: 0.5 },
    { stage: 'subtitle-info', failure: 'api', apiCode: '-101' },
    { stage: 'subtitle-info', failure: 'api', apiCode: NaN },
    { stage: 'subtitle-info', failure: 'api', apiCode: Infinity },
    { stage: 'subtitle-info', failure: 'api', apiCode: null },
  ])('rejects malformed unknown diagnostics with a fixed content-free error', subtitleDiagnostic => {
    expect(() => decodeBilibiliReply({ ...valid, subtitleReason: 'request-failed', subtitleDiagnostic })).toThrowError(new Error('Invalid Bilibili reply'))
  })

  it('rejects diagnostics on a loaded subtitle response', () => {
    expect(() => decodeBilibiliReply({ ...valid, subtitleStatus: 'loaded', subtitleDiagnostic: { stage: 'subtitle-file', failure: 'json' } })).toThrowError(new Error('Invalid Bilibili reply'))
  })

  it('contains errors thrown by unknown diagnostic field getters', () => {
    const subtitleDiagnostic = Object.defineProperty({}, 'stage', { get() { throw new Error('generated-sensitive-diagnostic') } })
    expect(() => decodeBilibiliReply({ ...valid, subtitleReason: 'request-failed', subtitleDiagnostic })).toThrowError(new Error('Invalid Bilibili reply'))
  })

  it('contains property-access failures behind the same fixed error', () => {
    const hostile = Object.defineProperty({}, 'code', { get() { throw new Error('generated-sensitive-data') } })
    expect(() => decodeBilibiliReply(hostile)).toThrowError(new Error('Invalid Bilibili reply'))
  })
})
