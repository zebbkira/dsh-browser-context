// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { decodeWecomSelectionReply, wecomSelectionScript } from '../src/readers/wecom-selection.ts'

const confirmedAbi = `
const h={ygL:Symbol('reader')};
class Melo {
  getRefText(e){const t=this.factory.get(h.ygL);return t?t.getRefText(e):""}
  isCopyable(){return this._docEnv.copyable}
  getIndexFromRange(e){const t=this.state.getTextStream();return{first:t.getIndexFromGCP(e.begin()),last:t.getIndexFromGCP(e.end())}}
  get selection(){return this.state.selection}
}
const existingRange={begin(){return 2},end(){return 6}};
const editor=new Melo();
editor.isMeloEditor=true;
editor._docEnv={get copyable(){return fixture.permission()}};
editor.state={get selection(){fixture.selection();return existingRange},getTextStream(){return {getIndexFromGCP(value){return fixture.index(value)}}}};
editor.factory={get(key){if(key!==h.ygL)throw new Error('Wrong reader');return new class {getRefText(range){return fixture.text(range===existingRange)}}}};
window.pad={editor};
`

const confirmedWrapper = `
class SelectionWrapper {
  getCoreRange(){return this._coreRange}
  get gcpRange(){return this._coreRange.gcpRange}
  get gcpRanges(){const{tableCellGCPRanges:e}=this._coreRange;return e.length>0?e:this._coreRange.gcpRanges}
  reset(){forbidden()}
  setRangeTo(){forbidden()}
  updateTableSelectionCache(){forbidden()}
  validDeleteRange(){forbidden()}
}
const originalCore={tableCellGCPRanges:[],gcpRanges:[existingRange]};
const originalWrapper=new SelectionWrapper();
originalWrapper._coreRange=originalCore;
Object.defineProperty(editor.state,'selection',{value:originalWrapper});
`

function page(url = 'https://doc.weixin.qq.com/doc/example', abi = confirmedAbi) {
  const dom = new JSDOM('<title>Existing document</title><div>Document unchanged</div>', { url, runScripts: 'outside-only' })
  const fixture = {
    permission: vi.fn((): unknown => true), selection: vi.fn(),
    index: vi.fn((value: number): unknown => value), text: vi.fn((_sameRange: boolean): unknown => '选择😀正文'),
  }
  Reflect.set(dom.window, 'TextEncoder', TextEncoder)
  Reflect.set(dom.window, 'fixture', fixture)
  runInContext(abi, dom.getInternalVMContext())
  const evaluate = (source: string): unknown => runInContext(source, dom.getInternalVMContext())
  const capture = (bytes = 65536): unknown => evaluate(wecomSelectionScript(bytes))
  return { dom, fixture, evaluate, capture }
}

describe('version-pinned Melo selection capture', () => {
  it('uses the confirmed JS ABI and preserves the existing Range and document', () => {
    const { dom, fixture, evaluate, capture } = page()
    const observer = new dom.window.MutationObserver(() => {})
    observer.observe(dom.window.document, { subtree: true, childList: true, attributes: true, characterData: true })
    try {
      const before = dom.window.document.documentElement.outerHTML
      expect(decodeWecomSelectionReply(capture())).toEqual({ text: '选择😀正文' })
      expect(fixture.text).toHaveBeenCalledExactlyOnceWith(true)
      expect(fixture.index.mock.calls).toEqual([[2], [6]])
      expect(evaluate('editor.state.selection===existingRange')).toBe(true)
      expect(dom.window.document.documentElement.outerHTML).toBe(before)
      expect(observer.takeRecords()).toEqual([])
    } finally { observer.disconnect(); dom.window.close() }
  })

  it('refuses copy-denied before reading selection or text and does not change flags', () => {
    const { dom, fixture, evaluate, capture } = page()
    fixture.permission.mockReturnValue(false)
    try {
      expect(capture()).toEqual({ code: 'copy-denied', stage: 'permission' })
      expect(fixture.selection).not.toHaveBeenCalled()
      expect(fixture.index).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
      expect(evaluate('Object.getOwnPropertyDescriptor(editor._docEnv,"copyable").set')).toBeUndefined()
    } finally { dom.window.close() }
  })

  it.each(['editor.isMeloEditor=false', 'delete window.pad', 'window.pad={}', 'editor.isCopyable=function(){fixture.permission();return true}', 'Object.defineProperty(Melo.prototype,"selection",{get(){fixture.selection();return existingRange}})'])('rejects missing Melo or unknown ABI without reader calls: %s', alteration => {
    const { dom, fixture, evaluate, capture } = page()
    try {
      evaluate(alteration)
      expect(capture()).toMatchObject({ code: 'unsupported' })
      expect(fixture.permission).not.toHaveBeenCalled()
      expect(fixture.selection).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it.each(['http://doc.weixin.qq.com/doc/a', 'https://evil.test/doc/a', 'https://doc.weixin.qq.com/sheet/a'])('rejects unsupported page %s', url => {
    const { dom, fixture, capture } = page(url)
    try {
      expect(capture()).toEqual({ code: 'unsupported', stage: 'editor' })
      expect(fixture.permission).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it.each(['Object.defineProperty(window,"pad",{get:trap})', 'Object.defineProperty(window.pad,"editor",{get:trap})', 'Object.defineProperty(editor,"isMeloEditor",{get:trap})', 'Object.defineProperty(editor,"isCopyable",{get:trap})'])('does not execute unapproved accessors: %s', alteration => {
    const { dom, evaluate, capture } = page()
    const trap = vi.fn(() => { throw new Error('privateValue') })
    Reflect.set(dom.window, 'trap', trap)
    try {
      evaluate(alteration)
      expect(capture()).toMatchObject({ code: 'unsupported' })
      expect(trap).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('lets only the confirmed SDK access getter-backed Range methods', () => {
    const { dom, fixture, evaluate, capture } = page()
    const access = vi.fn()
    Reflect.set(dom.window, 'access', access)
    try {
      evaluate('Object.defineProperty(existingRange,"begin",{get(){access("begin");return function(){return 2}}});Object.defineProperty(existingRange,"end",{get(){access("end");return function(){return 6}}})')
      expect(capture()).toEqual({ text: '选择😀正文' })
      expect(access.mock.calls).toEqual([['begin'], ['end']])
      expect(fixture.text).toHaveBeenCalledExactlyOnceWith(true)
    } finally { dom.window.close() }
  })

  it('passes a Proxy Range to the SDK without probing its begin or end descriptors', () => {
    const { dom, fixture, evaluate, capture } = page()
    const access = vi.fn()
    Reflect.set(dom.window, 'access', access)
    try {
      evaluate('const proxyRange=new Proxy(existingRange,{get(target,key,receiver){access(key);return Reflect.get(target,key,receiver)},getOwnPropertyDescriptor(){throw new Error("Unexpected descriptor probe")}});Object.defineProperty(editor.state,"selection",{value:proxyRange});editor.factory={get(){return {getRefText(range){return fixture.text(range===proxyRange)}}}}')
      expect(capture()).toEqual({ text: '选择😀正文' })
      expect(access.mock.calls).toEqual([['begin'], ['end']])
      expect(fixture.text).toHaveBeenCalledExactlyOnceWith(true)
    } finally { dom.window.close() }
  })

  it('validates all SDK indices before invoking even the first text reader', () => {
    const { dom, fixture, evaluate, capture } = page()
    const events: string[] = []
    fixture.index.mockImplementation(value => { events.push(`index:${value}`); return value })
    fixture.text.mockImplementation(() => { events.push('text'); return 'part' })
    try {
      evaluate('Object.defineProperty(editor.state,"selection",{value:[existingRange,{begin(){return 8},end(){return 12}}]})')
      expect(capture()).toEqual({ text: 'part\npart' })
      expect(events).toEqual(['index:2', 'index:6', 'index:8', 'index:12', 'text', 'text'])
      fixture.text.mockClear()
      evaluate('Object.defineProperty(editor.state,"selection",{value:[existingRange,{}]})')
      expect(capture()).toMatchObject({ code: 'unsupported', stage: 'selection', selectionInfo: { kind: 'array' } })
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('contains a confirmed SDK Range getter exception as a fixed indices failure', () => {
    const { dom, fixture, evaluate, capture } = page()
    try {
      evaluate('Object.defineProperty(existingRange,"begin",{get(){throw new Error("privateValue")}})')
      expect(capture()).toEqual({ code: 'failed', stage: 'indices' })
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('uses bounded prototype lookup and ignores custom function toString methods', () => {
    const { dom, evaluate, capture } = page()
    const trap = vi.fn(() => { throw new Error('privateValue') })
    Reflect.set(dom.window, 'trap', trap)
    try {
      evaluate('for(const name of ["isCopyable","getRefText","getIndexFromRange"]){Melo.prototype[name].toString=trap};Object.getOwnPropertyDescriptor(Melo.prototype,"selection").get.toString=trap;Object.setPrototypeOf(editor,Object.create(Object.create(Melo.prototype)))')
      expect(capture()).toEqual({ text: '选择😀正文' })
      expect(trap).not.toHaveBeenCalled()
      evaluate('Object.setPrototypeOf(editor,Object.create(Object.create(Object.create(Object.create(Melo.prototype)))))')
      expect(capture()).toEqual({ code: 'unsupported', stage: 'abi' })
    } finally { dom.window.close() }
  })

  it('does not trust a forged custom toString on an unknown reader', () => {
    const { dom, evaluate, fixture, capture } = page()
    try {
      evaluate('editor.getRefText=function(e){fixture.text(true);return "privateValue"};editor.getRefText.toString=()=>\'getRefText(e){const t=this.factory.get(h.ygL);return t?t.getRefText(e):""}\'')
      expect(capture()).toEqual({ code: 'unsupported', stage: 'abi' })
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('returns empty-selection for equal indices without reading text', () => {
    const { dom, fixture, capture } = page()
    fixture.index.mockReturnValue(2)
    try {
      expect(capture()).toEqual({ code: 'empty-selection', stage: 'indices' })
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('rejects reversed indices without reading text', () => {
    const { dom, fixture, capture } = page()
    fixture.index.mockReturnValueOnce(6).mockReturnValueOnce(2)
    try {
      expect(capture()).toEqual({ code: 'failed', stage: 'indices' })
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('requires strictly true permission rather than truthy values', () => {
    const { dom, fixture, capture } = page()
    fixture.permission.mockReturnValue('true')
    try {
      expect(capture()).toEqual({ code: 'failed', stage: 'permission' })
      expect(fixture.selection).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('handles absent ranges and empty text without generating a new range', () => {
    const { dom, fixture, evaluate, capture } = page()
    try {
      fixture.text.mockReturnValue('')
      expect(capture()).toEqual({ code: 'empty-selection', stage: 'text' })
      fixture.text.mockClear()
      evaluate('Object.defineProperty(editor.state,"selection",{value:null})')
      expect(capture()).toEqual({ code: 'empty-selection', stage: 'selection' })
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it.each([-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Promise.resolve(2), { privateValue: true }])('rejects invalid indices without reading text: %s', invalid => {
    const { dom, fixture, capture } = page()
    fixture.index.mockReturnValue(invalid)
    try {
      expect(capture()).toEqual({ code: 'failed', stage: 'indices' })
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it.each([Promise.resolve('privateValue'), { privateValue: 'secret' }, undefined, 42])('rejects non-string text without serializing it', value => {
    const { dom, fixture, capture } = page()
    fixture.text.mockReturnValue(value)
    try { expect(capture()).toEqual({ code: 'failed', stage: 'text' }) }
    finally { dom.window.close() }
  })

  it.each(['permission', 'selection', 'index', 'text'] as const)('contains raw exceptions at fixed operation stage: %s', operation => {
    const { dom, fixture, capture } = page()
    fixture[operation].mockImplementation(() => { throw new Error('privateValue secret selected text') })
    try {
      const stages = { permission: 'permission', selection: 'selection', index: 'indices', text: 'text' }
      expect(capture()).toEqual({ code: 'failed', stage: stages[operation] })
      expect(JSON.stringify(capture())).not.toContain('privateValue')
    } finally { dom.window.close() }
  })

  it('enforces full UTF8 JSON bytes without truncation; tiny budgets do not inspect the page', () => {
    const { dom, fixture, capture } = page()
    try {
      const result = capture()
      const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
      expect(capture(bytes)).toEqual(result)
      expect(capture(bytes - 1)).toEqual({ code: 'too-large' })
      fixture.permission.mockClear()
      const trap = vi.fn(() => { throw new Error('privateValue') })
      Object.defineProperty(dom.window.document, 'URL', { get: trap })
      Object.defineProperty(dom.window, 'pad', { get: trap })
      for (const tiny of [0, 1, 11]) expect(capture(tiny)).toEqual({ code: 'too-large' })
      expect(trap).not.toHaveBeenCalled()
      expect(fixture.permission).not.toHaveBeenCalled()
      for (const invalid of [-1, NaN, Infinity, 2.5]) expect(() => wecomSelectionScript(invalid)).toThrow(/^Invalid WeCom selection budget$/)
    } finally { dom.window.close() }
  })

  it('never invokes clipboard, credentials, storage, fetch, DOM selection, or mutation APIs', () => {
    const { dom, capture, evaluate } = page()
    const forbidden = vi.fn(() => { throw new Error('Forbidden side effect') })
    for (const name of ['fetch', 'getSelection']) Reflect.set(dom.window, name, forbidden)
    for (const name of ['localStorage', 'sessionStorage']) Object.defineProperty(dom.window, name, { get: forbidden })
    for (const name of ['clipboard', 'credentials']) Object.defineProperty(dom.window.navigator, name, { get: forbidden })
    Object.defineProperty(dom.window.document, 'cookie', { get: forbidden, set: forbidden })
    Reflect.set(dom.window, 'forbidden', forbidden)
    evaluate('for(const name of ["setCopyable","setRange","setContent","getRangeFromIndex","getCopyContent","writeHtmlToClipboard"]){editor[name]=forbidden};existingRange.setRange=forbidden')
    try {
      expect(capture()).toEqual({ text: '选择😀正文' })
      expect(forbidden).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it.each([1, 2])('reads %s original selection-array ranges in order without replacing them', count => {
    const { dom, fixture, evaluate, capture } = page()
    try {
      evaluate(`const secondRange={begin(){return 8},end(){return 12}};const originalRanges=[existingRange,secondRange].slice(0,${count});Object.defineProperty(editor.state,'selection',{value:originalRanges});editor.factory={get(){return {getRefText(range){if(!originalRanges.includes(range))throw new Error('Replaced range');return fixture.text(range===existingRange)}}}}`)
      fixture.text.mockImplementation(same => same ? '第一😀' : '第二段')
      expect(decodeWecomSelectionReply(capture())).toEqual({ text: count === 1 ? '第一😀' : '第一😀\n第二段' })
      expect(evaluate('editor.state.selection===originalRanges&&originalRanges[0]===existingRange')).toBe(true)
      expect(fixture.index.mock.calls).toEqual(count === 1 ? [[2], [6]] : [[2], [6], [8], [12]])
    } finally { dom.window.close() }
  })

  it('treats an empty selection array as empty without invoking range readers', () => {
    const { dom, fixture, evaluate, capture } = page()
    try {
      evaluate('Object.defineProperty(editor.state,"selection",{value:[]})')
      expect(capture()).toEqual({ code: 'empty-selection', stage: 'selection' })
      expect(fixture.index).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it.each(['[existingRange,{}]', '[{wrapped:existingRange}]', 'Array(65).fill(existingRange)', '[existingRange,,existingRange]'])('rejects mixed or unsupported array shapes before reading any text: %s', ranges => {
    const { dom, fixture, evaluate, capture } = page()
    try {
      evaluate(`Object.defineProperty(editor.state,'selection',{value:${ranges}})`)
      const response = decodeWecomSelectionReply(capture())
      expect(response).toMatchObject({ code: 'unsupported', stage: 'selection', selectionInfo: { kind: 'array' } })
      expect(fixture.text).not.toHaveBeenCalled()
      if (!('code' in response) || !response.selectionInfo) throw new Error('Expected descriptor diagnostics')
      if (ranges === '[{wrapped:existingRange}]') expect(response.selectionInfo.firstItem?.members).toContainEqual({ name: 'wrapped', type: 'object', depth: 0 })
    } finally { dom.window.close() }
  })

  it('ignores empty ranges and empty range text while preserving nonempty result order', () => {
    const { dom, fixture, evaluate, capture } = page()
    try {
      evaluate('Object.defineProperty(editor.state,"selection",{value:[{begin(){return 1},end(){return 1}},existingRange,existingRange]})')
      fixture.text.mockReturnValueOnce('').mockReturnValueOnce('保留😀')
      expect(capture()).toEqual({ text: '保留😀' })
      expect(fixture.text).toHaveBeenCalledTimes(2)
    } finally { dom.window.close() }
  })

  it('reports filtered descriptors without property values, getter execution or custom toString calls', () => {
    const { dom, fixture, evaluate, capture } = page()
    const trap = vi.fn(() => { throw new Error('privateValue') })
    Reflect.set(dom.window, 'trap', trap)
    try {
      evaluate('const shape={wrapped:existingRange,count:987654321,safeLabel:"privateValue",privateThing:"secret",DocId:"secret",text:"privateValue",authToken:"secret",get marker(){trap()},read(){return 1}};shape.read.toString=trap;Object.defineProperty(editor.state,"selection",{value:shape})')
      const result = decodeWecomSelectionReply(capture())
      expect(result).toMatchObject({ code: 'unsupported', stage: 'selection', selectionInfo: { kind: 'object' } })
      expect(JSON.stringify(result)).not.toMatch(/987654321|privateValue|privateThing|DocId|authToken|secret/)
      expect(trap).not.toHaveBeenCalled()
      expect(fixture.index).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
      if (!('code' in result) || !result.selectionInfo) throw new Error('Expected selection metadata')
      expect(result.selectionInfo.members).toContainEqual({ name: 'wrapped', type: 'object', depth: 0 })
      expect(result.selectionInfo.members.find(member => member.name === 'marker')).toMatchObject({ type: 'accessor', depth: 0 })
      const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
      expect(capture(bytes)).toEqual(result)
      expect(capture(bytes - 1)).toEqual({ code: 'too-large' })
    } finally { dom.window.close() }
  })

  it('limits static definition UTF8 bytes, total definitions and total member counts', () => {
    const { dom, evaluate, capture } = page()
    const prefix = 'function read(){/*'
    const suffix = '*/}'
    const exact = prefix + 'x'.repeat(1024 - prefix.length - suffix.length) + suffix
    const oversized = prefix + 'x'.repeat(1025 - prefix.length - suffix.length) + suffix
    try {
      evaluate(`const diagnosticShape={readA:(${exact}),readB:(${oversized})};Object.defineProperty(editor.state,'selection',{value:diagnosticShape})`)
      const result = decodeWecomSelectionReply(capture())
      if (!('code' in result) || !result.selectionInfo) throw new Error('Expected selection metadata')
      expect(result.selectionInfo.members.find(member => member.name === 'readA')?.definition).toBe(exact)
      expect(result.selectionInfo.members.find(member => member.name === 'readB')?.definition).toBeUndefined()
      expect(result.selectionInfo.truncated).toBe(true)
      evaluate('for(let index=0;index<50;index++){diagnosticShape[`method${index}`]=function read(){return 1}}')
      const limited = decodeWecomSelectionReply(capture())
      if (!('code' in limited) || !limited.selectionInfo) throw new Error('Expected selection metadata')
      expect(limited.selectionInfo.members).toHaveLength(32)
      expect(limited.selectionInfo.members.filter(member => member.definition !== undefined).length).toBeLessThanOrEqual(16)
    } finally { dom.window.close() }
  })

  it('preserves API identifiers, excludes opaque keys, deduplicates shadows and stops before Object.prototype', () => {
    const { dom, evaluate, capture } = page()
    const trap = vi.fn(() => { throw new Error('privateClosureValue') })
    Reflect.set(dom.window, 'trap', trap)
    try {
      evaluate('const privateClosureValue="never-return-this";class ShapeBase{isValid(){return trap(privateClosureValue)}getTextRange(){return trap(privateClosureValue)}validRange(){return trap(privateClosureValue)}};const diagnostic=new ShapeBase();diagnostic.isValid=function ownValid(){return trap(privateClosureValue)};diagnostic.authToken="secret";diagnostic.w123_opaqueKey="secret";diagnostic.abcdef0123456789abcdef0123456789="secret";diagnostic.opaqueId="secret";diagnostic["https://private.test/doc"]="secret";Object.defineProperty(editor.state,"selection",{value:diagnostic})')
      const reply = decodeWecomSelectionReply(capture())
      if (!('code' in reply) || !reply.selectionInfo) throw new Error('Expected selection metadata')
      const members = reply.selectionInfo.members
      expect(members.map(member => member.name)).toEqual(['isValid', 'getTextRange', 'validRange'])
      expect(members.filter(member => member.name === 'isValid')).toHaveLength(1)
      expect(members.find(member => member.name === 'isValid')?.depth).toBe(0)
      expect(members.find(member => member.name === 'getTextRange')?.depth).toBe(1)
      expect(reply.selectionInfo.truncated).toBe(false)
      expect(JSON.stringify(reply)).not.toMatch(/never-return-this|secret|w123_|abcdef0123|https:|constructor|__proto__|hasOwnProperty/)
      expect(trap).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('validates metadata privacy, bounds, permitted failure stages and field projection', () => {
    const member = { name: 'wrapped', type: 'object', depth: 0 }
    const info = { kind: 'object', members: [member], truncated: false }
    const reply = { code: 'unsupported', stage: 'selection', selectionInfo: info }
    expect(decodeWecomSelectionReply({ ...reply, selectionInfo: { ...info, extra: 'secret', members: [{ ...member, value: 'secret' }] } })).toEqual(reply)
    for (const name of ['privateField', 'DocId', 'text', 'userName', 'authToken', 'cookie', 'session', 'https://example.test/key', 'url', 'uuid', 'opaqueId', 'w123_opaqueKey', 'abcdef0123456789abcdef0123456789', 'constructor', '__proto__', 'prototype', '0']) expect(() => decodeWecomSelectionReply({ ...reply, selectionInfo: { ...info, members: [{ ...member, name }] } })).toThrow(/^Invalid WeCom selection reply$/)
    for (const invalid of [
      { ...info, members: Array(33).fill(member) },
      { ...info, members: [{ ...member, depth: 4 }] },
      { ...info, members: [{ ...member, type: 'function', definition: '中'.repeat(342) }] },
      { ...info, members: Array(17).fill({ ...member, type: 'function', definition: 'function read(){}' }) },
      { ...info, firstItem: { members: [], truncated: false } },
      { ...info, truncated: 'false' },
    ]) expect(() => decodeWecomSelectionReply({ ...reply, selectionInfo: invalid })).toThrow(/^Invalid WeCom selection reply$/)
    for (const disallowed of [{ text: '正文', selectionInfo: info }, { ...reply, code: 'copy-denied' }, { ...reply, stage: 'text' }, { code: 'unsupported', selectionInfo: info }]) expect(() => decodeWecomSelectionReply(disallowed)).toThrow(/^Invalid WeCom selection reply$/)
  })

  it('unwraps the confirmed selection wrapper to original core ranges without mutation', () => {
    const { dom, fixture, evaluate, capture } = page()
    const forbidden = vi.fn(() => { throw new Error('Forbidden mutation') })
    Reflect.set(dom.window, 'forbidden', forbidden)
    const observer = new dom.window.MutationObserver(() => {})
    observer.observe(dom.window.document, { subtree: true, childList: true, attributes: true, characterData: true })
    try {
      evaluate(confirmedWrapper)
      const before = dom.window.document.documentElement.outerHTML
      expect(capture()).toEqual({ text: '选择😀正文' })
      expect(fixture.text).toHaveBeenCalledExactlyOnceWith(true)
      expect(evaluate('editor.state.selection===originalWrapper&&originalWrapper._coreRange===originalCore&&originalCore.gcpRanges[0]===existingRange')).toBe(true)
      expect(forbidden).not.toHaveBeenCalled()
      expect(observer.takeRecords()).toEqual([])
      expect(dom.window.document.documentElement.outerHTML).toBe(before)
      const bytes = new TextEncoder().encode(JSON.stringify({ text: '选择😀正文' })).byteLength
      expect(capture(bytes)).toEqual({ text: '选择😀正文' })
      expect(capture(bytes - 1)).toEqual({ code: 'too-large' })
    } finally { observer.disconnect(); dom.window.close() }
  })

  it('uses the confirmed getter table-cell priority without reading fallback core ranges', () => {
    const { dom, fixture, evaluate, capture } = page()
    const forbidden = vi.fn(() => { throw new Error('Unexpected fallback read or mutation') })
    Reflect.set(dom.window, 'forbidden', forbidden)
    try {
      evaluate(confirmedWrapper)
      evaluate('const tableRange={begin(){return 10},end(){return 20}};originalCore.tableCellGCPRanges=[tableRange];Object.defineProperty(originalCore,"gcpRanges",{get:forbidden});editor.factory={get(){return {getRefText(range){return fixture.text(range===tableRange)}}}}')
      expect(capture()).toEqual({ text: '选择😀正文' })
      expect(fixture.text).toHaveBeenCalledExactlyOnceWith(true)
      expect(fixture.index.mock.calls).toEqual([[10], [20]])
      expect(forbidden).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('returns empty-selection for a confirmed wrapper with empty core ranges', () => {
    const { dom, fixture, evaluate, capture } = page()
    try {
      evaluate(confirmedWrapper)
      evaluate('originalCore.gcpRanges=[]')
      expect(capture()).toEqual({ code: 'empty-selection', stage: 'selection' })
      expect(fixture.index).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it.each(['Object.defineProperty(SelectionWrapper.prototype,"gcpRanges",{get(){return forbidden()}})', 'SelectionWrapper.prototype.getCoreRange=function(){return forbidden()}'])('rejects an unknown wrapper source without executing it: %s', alteration => {
    const { dom, fixture, evaluate, capture } = page()
    const forbidden = vi.fn(() => { throw new Error('privateValue') })
    Reflect.set(dom.window, 'forbidden', forbidden)
    try {
      evaluate(confirmedWrapper)
      evaluate(alteration)
      expect(capture()).toMatchObject({ code: 'unsupported', stage: 'selection', selectionInfo: { kind: 'object' } })
      expect(forbidden).not.toHaveBeenCalled()
      expect(fixture.index).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('contains confirmed wrapper getter exceptions and rejects nonarray results without guessing', () => {
    const { dom, fixture, evaluate, capture } = page()
    try {
      evaluate(confirmedWrapper)
      evaluate('originalCore.gcpRanges=existingRange')
      expect(capture()).toMatchObject({ code: 'unsupported', stage: 'selection', selectionInfo: { kind: 'object' } })
      evaluate('Object.defineProperty(originalCore,"tableCellGCPRanges",{get(){throw new Error("privateValue secret error")}})')
      const failed = capture()
      expect(failed).toMatchObject({ code: 'failed', stage: 'selection', selectionInfo: { kind: 'object' } })
      expect(JSON.stringify(failed)).not.toMatch(/privateValue|secret error/)
      expect(fixture.index).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('uses the unwrapped array as diagnostics target after successful wrapper decoding', () => {
    const { dom, fixture, evaluate, capture } = page()
    try {
      evaluate(confirmedWrapper)
      evaluate('originalCore.gcpRanges=[{wrapped:existingRange}]')
      const result = decodeWecomSelectionReply(capture())
      expect(result).toMatchObject({ code: 'unsupported', stage: 'selection', selectionInfo: { kind: 'array', firstItem: { members: [{ name: 'wrapped', type: 'object', depth: 0 }] } } })
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('refuses copy-denied before looking inside a wrapper or invoking its confirmed getter', () => {
    const { dom, fixture, evaluate, capture } = page()
    const forbidden = vi.fn(() => { throw new Error('privateValue') })
    Reflect.set(dom.window, 'forbidden', forbidden)
    try {
      evaluate(confirmedWrapper)
      evaluate('Object.defineProperty(originalCore,"tableCellGCPRanges",{get:forbidden});Object.defineProperty(originalWrapper,"_coreRange",{get:forbidden})')
      fixture.permission.mockReturnValue(false)
      expect(capture()).toEqual({ code: 'copy-denied', stage: 'permission' })
      expect(forbidden).not.toHaveBeenCalled()
      expect(fixture.index).not.toHaveBeenCalled()
      expect(fixture.text).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })

  it('projects validated IPC fields and rejects malformed replies with fixed errors', () => {
    expect(decodeWecomSelectionReply('{"text":"选择😀","privateValue":"secret"}')).toEqual({ text: '选择😀' })
    expect(decodeWecomSelectionReply({ code: 'unsupported', stage: 'abi', privateValue: 'secret' })).toEqual({ code: 'unsupported', stage: 'abi' })
    expect(decodeWecomSelectionReply({ code: 'too-large' })).toEqual({ code: 'too-large' })
    for (const malformed of ['privateValue{', null, [], {}, { text: '' }, { text: Promise.resolve('secret') }, { code: 'privateValue' }, { code: 'failed', stage: 'privateValue' }, { text: 'secret', code: 'failed' }, { get text() { throw new Error('privateValue') } }]) expect(() => decodeWecomSelectionReply(malformed)).toThrow(/^Invalid WeCom selection reply$/)
  })
})
