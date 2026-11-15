// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { decodeWecomReply, isWecomDocument, wecomDocumentScript, wecomMinimumReplyBytes } from '../src/readers/wecom.ts'

function page(html: string, url = 'https://doc.weixin.qq.com/doc/example') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
  Reflect.set(dom.window, 'TextEncoder', TextEncoder)
  const capture = (budget = 65536): unknown => runInContext(wecomDocumentScript(budget), dom.getInternalVMContext())
  return { dom, capture }
}

describe('loaded WeCom document snapshots', () => {
  it('recognizes only HTTPS WeCom document paths', () => {
    expect(isWecomDocument('https://doc.weixin.qq.com/doc/example?x=1')).toBe(true)
    for (const url of ['http://doc.weixin.qq.com/doc/a', 'https://doc.weixin.qq.com.evil.test/doc/a', 'https://doc.weixin.qq.com/sheet/a', 'https://doc.weixin.qq.com/doc', 'https://user:secret@doc.weixin.qq.com/doc/a', 'not a url']) expect(isWecomDocument(url)).toBe(false)
  })

  it.each(['class="ProseMirror"', 'class="ql-editor"', 'data-slate-editor="true"', 'data-lexical-editor="true"'])('reads only a recognized editor: %s', marker => {
    const { dom, capture } = page(`<title>局部文档</title><nav>navigation-secret</nav><div ${marker} role="textbox"><p>正文😀</p><p>Second line</p><div role="toolbar">toolbar-secret</div><input type="password" value="password-secret"><textarea>field-secret</textarea><div role="textbox">custom-field-secret</div><script>window.pageRan=true</script><p hidden>hidden-secret</p><span style="display:none">invisible-secret</span></div><footer>footer-secret</footer>`)
    try {
      const result = decodeWecomReply(capture())
      expect(result).toEqual({ status: 'ok', url: dom.window.document.URL, title: '局部文档', text: '正文😀\nSecond line', format: 'text', coverage: 'loaded' })
      expect(Reflect.get(dom.window, 'pageRan')).toBeUndefined()
    } finally { dom.window.close() }
  })

  it('does not use body, generic document roles, unrelated frames, or password fields as a fallback', () => {
    const { dom, capture } = page('<body class="ProseMirror"><div role="document">privateBody</div><input type="password" value="secret"><iframe src="https://unrelated.test"></iframe></body>')
    try {
      const frame = dom.window.document.querySelector('iframe')
      if (!frame) throw new Error('Expected unrelated frame')
      // JSDOM does not enforce browser cross-origin contentDocument nullability.
      Object.defineProperty(frame, 'contentDocument', { value: null })
      Object.defineProperty(dom.window.document.body, 'innerText', { get() { throw new Error('privateBody') } })
      const result = decodeWecomReply(capture())
      expect(result.status).toBe('no-document')
      expect(JSON.stringify(result)).not.toContain('privateBody')
      if (result.status !== 'no-document') throw new Error('Expected diagnostics')
      expect(result.diagnostic.reason).toBe('model-not-found')
      expect(result.diagnostic.counts.iframes).toBe(1)
      expect(result.diagnostic.counts.accessibleFrames).toBe(0)
    } finally { dom.window.close() }
  })

  it('counts only non-null accessible frame documents without inspecting their contents', () => {
    const { dom, capture } = page('<iframe></iframe><iframe></iframe><iframe></iframe>')
    try {
      const frames = dom.window.document.querySelectorAll('iframe')
      const childDocument = frames[0].contentDocument
      if (!childDocument) throw new Error('Expected same-origin frame')
      const forbidden = vi.fn(() => { throw new Error('Frame contents must not be read') })
      vi.spyOn(childDocument, 'body', 'get').mockImplementation(forbidden)
      vi.spyOn(childDocument, 'querySelectorAll').mockImplementation(forbidden)
      Object.defineProperty(frames[1], 'contentDocument', { value: null })
      Object.defineProperty(frames[2], 'contentDocument', { get() { throw new dom.window.DOMException('Blocked frame', 'SecurityError') } })
      const result = decodeWecomReply(capture())
      expect(result).toMatchObject({ status: 'no-document', diagnostic: { counts: { iframes: 3, accessibleFrames: 1 } } })
      expect(forbidden).not.toHaveBeenCalled()
    } finally { vi.restoreAllMocks(); dom.window.close() }
  })

  it.each(['data-can-copy="false"', 'data-can-read="false"', 'data-copy-permission="denied"', 'data-read-permission="denied"'])('refuses explicit permission prohibition %s', prohibition => {
    const { dom, capture } = page(`<div ${prohibition}></div><div class="ProseMirror"><p>privateBody</p></div>`)
    try {
      const result = decodeWecomReply(capture())
      expect(result).toMatchObject({ status: 'no-document', diagnostic: { reason: 'read-denied' } })
      expect(JSON.stringify(result)).not.toContain('privateBody')
    } finally { dom.window.close() }
  })

  it('returns empty diagnostics for a recognized editor without safe rendered text', () => {
    const { dom, capture } = page('<div class="ql-editor"><input value="privateBody"><script>privateBody</script></div>')
    try { expect(decodeWecomReply(capture())).toMatchObject({ status: 'no-document', diagnostic: { reason: 'empty' } }) }
    finally { dom.window.close() }
  })

  it('reports only fixed descriptors and safe script basenames, without evaluating model getters', () => {
    const scripts = Array.from({ length: 20 }, (_, index) => `<script src="https://cdn.test/private/path/renderer-${index}.js?DocId=secret#private"></script>`).join('')
    const { dom, capture } = page(`<p>privateBody</p><script src="/bad%20name.js"></script><script src="data:text/javascript,secret.js"></script>${scripts}`)
    const getter = vi.fn(() => { throw new Error('privateBody') })
    for (const name of ['pad', 'App']) Object.defineProperty(dom.window, name, { get: getter })
    try {
      const result = decodeWecomReply(capture())
      if (result.status !== 'no-document') throw new Error('Expected diagnostics')
      expect(result.diagnostic.knownWindowRoots).toHaveLength(16)
      for (const name of ['pad', 'App']) expect(result.diagnostic.knownWindowRoots).toContainEqual({ name, present: true, type: 'accessor' })
      expect(result.diagnostic.knownWindowRoots).toContainEqual({ name: 'pad.editor', present: false, type: 'absent' })
      expect(result.diagnostic.scriptNames).toEqual(Array.from({ length: 16 }, (_, index) => `renderer-${index}.js`))
      expect(getter).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toMatch(/privateBody|DocId|secret|cdn\.test/)
    } finally { dom.window.close() }
  })

  it('inspects fixed nested model descriptors and inherited methods without calling them', () => {
    const { dom, capture } = page('<canvas></canvas>')
    const forbidden = vi.fn(() => { throw new Error('privateBody') })
    const editor: object = Object.create({ getText: forbidden })
    Object.defineProperty(editor, 'getContents', { get: forbidden })
    Reflect.set(dom.window, 'pad', { editor, model: { privateBody: 'secret' } })
    try {
      const result = decodeWecomReply(capture())
      if (result.status !== 'no-document') throw new Error('Expected diagnostics')
      expect(result.diagnostic.knownWindowRoots).toContainEqual({ name: 'pad.editor', present: true, type: 'object' })
      expect(result.diagnostic.knownWindowRoots).toContainEqual({ name: 'pad.editor.getText', present: true, type: 'function' })
      expect(result.diagnostic.knownWindowRoots).toContainEqual({ name: 'pad.editor.getContents', present: true, type: 'accessor' })
      expect(forbidden).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toMatch(/privateBody|secret/)
    } finally { dom.window.close() }
  })

  it('does not descend through an application accessor to look up a model', () => {
    const { dom, capture } = page('<canvas></canvas>')
    const getter = vi.fn(() => { throw new Error('privateBody') })
    const pad = {}
    Object.defineProperty(pad, 'editor', { get: getter })
    Reflect.set(dom.window, 'pad', pad)
    try {
      const result = decodeWecomReply(capture())
      if (result.status !== 'no-document') throw new Error('Expected diagnostics')
      expect(result.diagnostic.knownWindowRoots).toContainEqual({ name: 'pad.editor', present: true, type: 'accessor' })
      expect(result.diagnostic.knownWindowRoots).toContainEqual({ name: 'pad.editor.getText', present: false, type: 'absent' })
      expect(getter).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('lists bounded editor member metadata without values, getters, or method calls', () => {
    const { dom, capture } = page('<canvas></canvas>')
    const method = vi.fn((_start: number, _end: number) => { throw new Error('privateBody') })
    const getter = vi.fn(() => { throw new Error('privateBody') })
    const editor: object = Object.create({ getDocumentText: method })
    Object.defineProperty(editor, 'contentModel', { get: getter })
    Object.assign(editor, { data: { text: 'hiddenDocumentValue' }, title: 'hiddenDocumentTitle', authToken: 'secretValue', w3_hiddenDocumentId: 'hiddenValue' })
    Reflect.set(dom.window, 'pad', { editor })
    try {
      const result = decodeWecomReply(capture())
      if (result.status !== 'no-document') throw new Error('Expected diagnostics')
      expect(result.diagnostic.editorMembers).toEqual(expect.arrayContaining([
        { name: 'getDocumentText', type: 'function', depth: 1, arity: 2 },
        { name: 'contentModel', type: 'accessor', depth: 0 },
        { name: 'data', type: 'object', depth: 0 },
      ]))
      expect(result.diagnostic.editorMembersTruncated).toBe(false)
      expect(JSON.stringify(result)).not.toMatch(/hiddenDocument|hiddenValue|secretValue|authToken|privateBody/)
      expect(method).not.toHaveBeenCalled()
      expect(getter).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('caps editor inventory and rejects forged sensitive or invalid metadata', () => {
    const { dom, capture } = page('<canvas></canvas>')
    const editor: Record<string, number> = {}
    for (let index = 0; index < 220; index += 1) editor[`field${index}`] = index
    Reflect.set(dom.window, 'pad', { editor })
    try {
      const result = decodeWecomReply(capture())
      if (result.status !== 'no-document') throw new Error('Expected diagnostics')
      expect(result.diagnostic.editorMembers).toHaveLength(192)
      expect(result.diagnostic.editorMembersTruncated).toBe(true)
      for (const member of [{ name: 'authToken', type: 'string', depth: 0 }, { name: 'readText', type: 'function', depth: 4 }, { name: 'readText', type: 'function', depth: 0, arity: 33 }]) {
        expect(() => decodeWecomReply({ ...result, diagnostic: { ...result.diagnostic, editorMembers: [member], editorMembersTruncated: false } })).toThrow('Invalid WeCom reply')
      }
    } finally { dom.window.close() }
  })

  it('includes later editor methods and only metadata from the two observed model objects', () => {
    const { dom, capture } = page('<canvas></canvas>')
    const method = vi.fn(() => { throw new Error('privateBody') })
    const root: object = Object.create({ getChildren: method })
    Object.assign(root, { children: [{ text: 'hiddenDocumentValue' }] })
    const editor: Record<string, unknown> = { root, modelWrapperMgr: { getModel: method } }
    for (let index = 0; index < 80; index += 1) editor[`field${index}`] = index
    editor.readOnlyText = method
    Reflect.set(dom.window, 'pad', { editor })
    try {
      const result = decodeWecomReply(capture())
      if (result.status !== 'no-document') throw new Error('Expected diagnostics')
      expect(result.diagnostic.editorMembers).toContainEqual({ name: 'readOnlyText', type: 'function', depth: 0, arity: 0 })
      expect(result.diagnostic.modelMembers.root.members).toContainEqual({ name: 'children', type: 'object', depth: 0 })
      expect(result.diagnostic.modelMembers.root.members).toContainEqual({ name: 'getChildren', type: 'function', depth: 1, arity: 0 })
      expect(result.diagnostic.modelMembers.modelWrapperMgr.members).toContainEqual({ name: 'getModel', type: 'function', depth: 0, arity: 0 })
      expect(method).not.toHaveBeenCalled()
      expect(JSON.stringify(result)).not.toMatch(/hiddenDocumentValue|privateBody/)
    } finally { dom.window.close() }
  })

  it('does not invoke model accessors and bounds model inventories separately', () => {
    const { dom, capture } = page('<canvas></canvas>')
    const getter = vi.fn(() => { throw new Error('privateBody') })
    const manager: Record<string, number> = {}
    for (let index = 0; index < 90; index += 1) manager[`field${index}`] = index
    const editor = { modelWrapperMgr: manager }
    Object.defineProperty(editor, 'root', { get: getter })
    Reflect.set(dom.window, 'pad', { editor })
    try {
      const result = decodeWecomReply(capture())
      if (result.status !== 'no-document') throw new Error('Expected diagnostics')
      expect(result.diagnostic.modelMembers.root).toEqual({ members: [], truncated: false })
      expect(result.diagnostic.modelMembers.modelWrapperMgr.members).toHaveLength(64)
      expect(result.diagnostic.modelMembers.modelWrapperMgr.truncated).toBe(true)
      expect(getter).not.toHaveBeenCalled()
      expect(() => decodeWecomReply({ ...result, diagnostic: { ...result.diagnostic, modelMembers: { ...result.diagnostic.modelMembers, root: { members: [{ name: 'authToken', type: 'string', depth: 0 }], truncated: false } } } })).toThrow('Invalid WeCom reply')
    } finally { dom.window.close() }
  })

  it('inspects only fixed reader definitions without invoking them or their custom toString', () => {
    const { dom, capture } = page('<canvas></canvas>')
    const opaqueValue = 'hiddenDocumentValue'
    let calls = 0
    const getRefText = function (_range: unknown) { calls += 1; return opaqueValue }
    getRefText.toString = () => { calls += 1; throw new Error('Do not call custom conversion') }
    const prototype = { getRefText }
    Object.defineProperty(prototype, 'selection', { get() { calls += 1; return opaqueValue } })
    const editor: object = Object.create(prototype)
    Object.assign(editor, { root: dom.window.document.createElement('div') })
    Reflect.set(dom.window, 'pad', { editor })
    try {
      const result = decodeWecomReply(capture())
      if (result.status !== 'no-document') throw new Error('Expected diagnostics')
      expect(result.diagnostic.readerDefinitions.find(definition => definition.name === 'getRefText')).toMatchObject({ status: 'available', source: expect.any(String) })
      expect(result.diagnostic.readerDefinitions.find(definition => definition.name === 'selection')).toMatchObject({ status: 'available', source: expect.any(String) })
      expect(result.diagnostic.readerDefinitions.find(definition => definition.name === 'isCopyable')).toEqual({ name: 'isCopyable', status: 'missing' })
      expect(result.diagnostic.modelMembers.root).toEqual({ members: [], truncated: false })
      expect(JSON.stringify(result)).not.toContain(opaqueValue)
      expect(calls).toBe(0)
    } finally { dom.window.close() }
  })

  it('omits oversized definitions rather than truncating or executing them', () => {
    const { dom, capture } = page('<canvas></canvas>')
    const definition: unknown = runInContext('(function isCopyable(){/*' + 'x'.repeat(2500) + '*/return true})', dom.getInternalVMContext())
    Reflect.set(dom.window, 'pad', { editor: { isCopyable: definition } })
    try {
      const result = decodeWecomReply(capture())
      if (result.status !== 'no-document') throw new Error('Expected diagnostics')
      expect(result.diagnostic.readerDefinitions.find(definition => definition.name === 'isCopyable')).toEqual({ name: 'isCopyable', status: 'oversized' })
      const forged = result.diagnostic.readerDefinitions.map(definition => definition.name === 'isCopyable' ? { name: definition.name, status: 'available', source: '😀'.repeat(513) } : definition)
      expect(() => decodeWecomReply({ ...result, diagnostic: { ...result.diagnostic, readerDefinitions: forged } })).toThrow('Invalid WeCom reply')
    } finally { dom.window.close() }
  })

  it.each(['<title>元数据😀</title><div class="ProseMirror"><p>中文😀正文</p></div>', '<p>privateBody</p><canvas></canvas>'])('budgets full JSON metadata with exact UTF8 bytes and no truncation', html => {
    const { dom, capture } = page(html)
    try {
      const result = capture()
      const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
      expect(capture(bytes)).toEqual(result)
      expect(capture(bytes - 1)).toEqual({ status: 'too-large' })
      expect(capture(22)).toEqual({ status: 'too-large' })
      expect(JSON.stringify(capture(wecomMinimumReplyBytes))).toHaveLength(wecomMinimumReplyBytes)
      expect(wecomMinimumReplyBytes).toBe(new TextEncoder().encode(JSON.stringify({ status: 'too-large' })).byteLength)
    } finally { dom.window.close() }
    for (const invalid of [0, 21, -1, NaN, Infinity, 22.5]) expect(() => wecomDocumentScript(invalid)).toThrow('Invalid WeCom reply budget')
  })

  it('does not mutate DOM, fetch, access clipboard or credentials, focus, or change selection', () => {
    const { dom, capture } = page('<div class="ProseMirror"><p>Loaded snapshot</p></div>')
    const forbidden = vi.fn(() => { throw new Error('Forbidden side effect') })
    for (const name of ['fetch', 'getSelection', 'focus']) Reflect.set(dom.window, name, forbidden)
    for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(dom.window, name, { get: forbidden })
    for (const name of ['clipboard', 'credentials']) Object.defineProperty(dom.window.navigator, name, { get: forbidden })
    Object.defineProperty(dom.window.document, 'cookie', { get: forbidden, set: forbidden })
    const observer = new dom.window.MutationObserver(() => {})
    observer.observe(dom.window.document, { subtree: true, childList: true, attributes: true, characterData: true })
    try {
      const before = dom.window.document.documentElement.outerHTML
      expect(decodeWecomReply(capture())).toMatchObject({ status: 'ok' })
      expect(observer.takeRecords()).toEqual([])
      expect(dom.window.document.documentElement.outerHTML).toBe(before)
      expect(forbidden).not.toHaveBeenCalled()
    } finally { observer.disconnect(); dom.window.close() }
  })

  it('validates IPC responses and projects away unowned fields', () => {
    const data = { status: 'ok', url: 'https://doc.weixin.qq.com/doc/a', title: 'Title', text: 'Loaded', format: 'text', coverage: 'loaded' }
    expect(decodeWecomReply(JSON.stringify({ ...data, privateBody: 'secret' }))).toEqual(data)
    expect(decodeWecomReply({ status: 'too-large', privateBody: 'secret' })).toEqual({ status: 'too-large' })
    const { dom, capture } = page('<p>privateBody</p>')
    try {
      const diagnostic = decodeWecomReply(capture())
      expect(decodeWecomReply({ ...diagnostic, privateBody: 'secret' })).toEqual(diagnostic)
      if (diagnostic.status !== 'no-document') throw new Error('Expected diagnostics')
      for (const malformed of [
        'privateBody{', null, [], {}, { ...data, coverage: 'complete' }, { ...data, text: '' }, { ...data, url: 'https://evil.test/doc/a' },
        { status: 'no-document', diagnostic: { ...diagnostic.diagnostic, reason: 'privateBody' } },
        { status: 'no-document', diagnostic: { ...diagnostic.diagnostic, counts: { ...diagnostic.diagnostic.counts, paragraphs: -1 } } },
        { status: 'no-document', diagnostic: { ...diagnostic.diagnostic, knownWindowRoots: [] } },
        { status: 'no-document', diagnostic: { ...diagnostic.diagnostic, scriptNames: ['https://privateBody.js'] } },
      ]) expect(() => decodeWecomReply(malformed)).toThrow(/^Invalid WeCom reply$/)
      const getter = { get status() { throw new Error('privateBody') } }
      expect(() => decodeWecomReply(getter)).toThrow(/^Invalid WeCom reply$/)
    } finally { dom.window.close() }
  })
})
