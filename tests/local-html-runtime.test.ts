import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { localHtmlBootstrapScript, localHtmlCommandScript, localHtmlDisposeScript } from '../src/browser/local-html-runtime.ts'
import { decodeElementPickerReply } from '../src/readers/element-picker.ts'
import type { LocalHtmlBundle, LocalHtmlCommand } from '../src/browser/local-html-types.ts'

// VM/JSDOM fixtures exercise fixed scripts and message ownership, not Electron isolation or native screenshots.
const doms: JSDOM[] = []
afterEach(() => { for (const dom of doms.splice(0)) dom.window.close(); vi.useRealTimers() })
const id = 'fixture-document'
const url = 'about:blank#lease-fixture'
const limits = { maxBytes: 1024 * 1024, maxFiles: 10, timeoutMs: 1000 }
function bundle(html = '<p>Public 你好😀</p>'): LocalHtmlBundle {
  return { source: { path: 'C:/private/file.html', resourceAddress: 'cwd:/file.html', version: 'authorized-v1' }, title: 'Host title', html, assets: [] }
}
function dom(html: string, address: string) {
  const value = new JSDOM(html, { url: address, runScripts: 'outside-only' })
  doms.push(value)
  Reflect.set(value.window, 'TextEncoder', TextEncoder); Reflect.set(value.window, 'TextDecoder', TextDecoder)
  return value
}
function fixture(input = bundle(), address = url, customLimits = limits) {
  const shell = dom('<body></body>', address)
  const evaluate = (source: string): unknown => runInContext(source, shell.getInternalVMContext())
  // Inert custom element avoids JSDOM's automatic iframe load; tests explicitly deliver document-load events.
  const create = shell.window.document.createElement.bind(shell.window.document)
  const frameWindow = { postMessage: vi.fn() }
  vi.spyOn(shell.window.document, 'createElement').mockImplementation((name: string) => {
    const node = create(name === 'iframe' ? 'fixture-frame' : name)
    if (name === 'iframe') Object.defineProperty(node, 'contentWindow', { value: frameWindow })
    return node
  })
  const boot = evaluate(localHtmlBootstrapScript(input, id, url, customLimits)) as Promise<unknown>
  const frame = shell.window.document.querySelector('fixture-frame') as HTMLElement & { srcdoc: string }
  const message = (data: unknown, source: unknown = frameWindow) => shell.window.dispatchEvent(new shell.window.MessageEvent('message', { data, source: source as Window }))
  const load = () => frame.dispatchEvent(new shell.window.Event('load'))
  const command = (value: LocalHtmlCommand, documentId = id) => evaluate(localHtmlCommandScript(documentId, value)) as Promise<unknown>
  const dispose = (documentId = id) => evaluate(localHtmlDisposeScript(documentId))
  const connect = () => {
    const child = dom('<body></body>', 'about:blank')
    Object.defineProperty(child.window, 'parent', { value: shell.window })
    const blob = vi.fn(() => 'blob:null/authorized-fixture')
    Reflect.set(child.window.URL, 'createObjectURL', blob)
    Reflect.set(shell.window, 'postMessage', vi.fn((data: unknown) => message(data)))
    frameWindow.postMessage.mockImplementation((data: unknown) => child.window.dispatchEvent(new child.window.MessageEvent('message', { data, source: shell.window })))
    const initial = new JSDOM(frame.srcdoc).window.document.querySelector('script')!.textContent!
    runInContext(initial, child.getInternalVMContext())
    const broker = child.window.document.scripts[child.window.document.scripts.length - 1]!.textContent!
    runInContext(broker, child.getInternalVMContext())
    return { child, blob, broker }
  }
  return { shell, evaluate, boot, frame, frameWindow, message, load, command, dispose, connect }
}
const ready = { documentId: id, requestId: 'bootstrap', type: 'ready' }

describe('local HTML fixed-script VM/JSDOM fixture', () => {
  it('keeps the lease URL, uses only allow-scripts, and waits for both broker-ready and first load', async () => {
    const f = fixture()
    expect(f.frame.getAttribute('sandbox')).toBe('allow-scripts')
    expect(f.frame.style.border).toBe('0px')
    expect(f.shell.window.document.body.style.margin).toBe('0px')
    const { child } = f.connect()
    expect(await f.command({ kind: 'status' })).toMatchObject({ ready: false, frameGeneration: 0 })
    f.load()
    expect(await f.boot).toMatchObject({ documentId: id, ready: true, frameGeneration: 1, viewport: { width: 1024, height: 768 } })
    expect(f.shell.window.location.href).toBe(url)
    expect(f.shell.window.document.body.textContent).toBe('')
    expect(child.window.document.querySelector('p')?.textContent).toBe('Public 你好😀')
    f.dispose()
    expect(f.frame.isConnected).toBe(false)
    expect(await f.command({ kind: 'status' })).toEqual({ code: 'closed' })
  })
  it.each(['https://example.test/', 'about:blank#other'])('makes no DOM change outside the exact about:blank lease: %s', async address => {
    const f = fixture(bundle(), address)
    expect(await f.boot).toEqual({ code: 'frame' })
    expect(f.frame).toBeNull()
    expect(f.shell.window.document.body.innerHTML).toBe('')
  })
  it('ignores unrelated sources, wrong document ids and request ids, then invalidates irrevocably on another load', async () => {
    const f = fixture()
    f.load()
    f.message(ready, f.shell.window)
    f.message({ ...ready, documentId: 'other' })
    f.message({ ...ready, requestId: 'other' })
    expect(await f.command({ kind: 'status' })).toMatchObject({ ready: false })
    f.message(ready)
    await f.boot
    const selection = f.command({ kind: 'selection', maxBytes: 100 })
    const request = f.frameWindow.postMessage.mock.calls.at(-1)![0]
    f.message({ ...request, type: 'reply', value: { text: 'wrong source' } }, f.shell.window)
    f.message({ ...request, documentId: 'other', type: 'reply', value: { text: 'wrong id' } })
    f.load()
    expect(await selection).toEqual({ code: 'changed' })
    f.message(ready)
    f.message({ ...request, type: 'reply', value: { text: 'stale', path: 'C:/secret' } })
    expect(await f.command({ kind: 'status' })).toMatchObject({ ready: false, frameGeneration: 2 })
    expect(await f.command({ kind: 'selection', maxBytes: 100 })).toEqual({ code: 'changed' })
    f.dispose()
  })
  it('normalizes untrusted reply fields and measures the whole original JSON rather than truncating', async () => {
    const f = fixture(); f.message(ready); f.load(); await f.boot
    const selection = f.command({ kind: 'selection', maxBytes: 100 })
    let request = f.frameWindow.postMessage.mock.calls.at(-1)![0]
    f.message({ ...request, type: 'reply', value: { text: 'safe', path: 'not-authority', url: 'file:///not-authority' } })
    expect(await selection).toEqual({ text: 'safe' })
    const tooLarge = f.command({ kind: 'selection', maxBytes: 20 })
    request = f.frameWindow.postMessage.mock.calls.at(-1)![0]
    f.message({ ...request, type: 'reply', value: { text: '你好😀 "quoted"', extra: 'private' } })
    expect(await tooLarge).toEqual({ code: 'too-large' })
    f.dispose()
  })
  it('times out finite requests and missing bootstrap but not the interactive picker; cancel and dispose settle pending work', async () => {
    vi.useFakeTimers()
    const f = fixture(); f.message(ready); f.load(); await f.boot
    const selection = f.command({ kind: 'selection', maxBytes: 100 })
    await vi.advanceTimersByTimeAsync(limits.timeoutMs)
    expect(await selection).toEqual({ code: 'timeout' })
    const pick = f.command({ kind: 'pick', nonce: 'one', instruction: 'Pick', maxBytes: 1000 })
    let settled = false; void pick.then(() => { settled = true })
    const check = f.command({ kind: 'check', nonce: 'one' })
    await vi.advanceTimersByTimeAsync(20000)
    expect(await check).toEqual({ code: 'timeout' })
    expect(settled).toBe(false)
    await f.command({ kind: 'cancel', nonce: 'old' }); expect(settled).toBe(false)
    expect(await f.command({ kind: 'cancel', nonce: 'one' })).toBe(true)
    expect(await pick).toEqual({ code: 'cancelled' })
    const next = f.command({ kind: 'pick', nonce: 'two', instruction: 'Pick', maxBytes: 1000 })
    f.dispose('other'); expect(f.frame.isConnected).toBe(true)
    f.dispose(); expect(await next).toEqual({ code: 'closed' })
    const unready = fixture()
    await vi.advanceTimersByTimeAsync(limits.timeoutMs)
    expect(await unready.boot).toEqual({ code: 'timeout' })
    expect(unready.frame.isConnected).toBe(false)
  })
  it('uses the actual picker inside the child VM, with nonce-only checks, Escape and host cancellation cleanup', async () => {
    const g = fixture(bundle('<button>Pick 你好</button>'))
    const { child } = g.connect(); g.load(); await g.boot
    const button = child.window.document.querySelector('button')!
    const bounds = { left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40 }
    Object.defineProperty(button, 'getBoundingClientRect', { value: () => bounds })
    Object.defineProperty(child.window.Element.prototype, 'getClientRects', { value: () => [bounds] })
    Object.defineProperty(child.window.document, 'elementFromPoint', { value: () => button })
    const pick = g.command({ kind: 'pick', nonce: 'pick', instruction: '</script>"指引', maxBytes: 65536 })
    expect(child.window.document.documentElement.lastElementChild!.textContent).toBe('</script>"指引')
    child.window.dispatchEvent(new child.window.MouseEvent('click', { clientX: 15, clientY: 25, cancelable: true }))
    expect(decodeElementPickerReply(await pick, 65536)).toMatchObject({ tag: 'button', text: 'Pick 你好' })
    expect(await g.command({ kind: 'check', nonce: 'other' })).toEqual({ code: 'changed' })
    expect(await g.command({ kind: 'check', nonce: 'pick' })).toHaveProperty('element')
    await g.command({ kind: 'cancel', nonce: 'pick' })
    expect(Reflect.get(child.window, '__dshReferenceElementPicker')).toBeUndefined()
    const escape = g.command({ kind: 'pick', nonce: 'escape', instruction: '', maxBytes: 65536 })
    child.window.dispatchEvent(new child.window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    expect(await escape).toEqual({ code: 'cancelled' })
    const cancelled = g.command({ kind: 'pick', nonce: 'cancel', instruction: '', maxBytes: 65536 })
    await g.command({ kind: 'cancel', nonce: 'cancel' }); expect(await cancelled).toEqual({ code: 'cancelled' })
    expect(child.window.document.documentElement.querySelectorAll('div')).toHaveLength(0)
    const pending = g.command({ kind: 'pick', nonce: 'dispose', instruction: '', maxBytes: 65536 })
    g.dispose(); expect(await pending).toEqual({ code: 'closed' })
    expect(Reflect.get(child.window, '__dshReferenceElementPicker')).toBeUndefined()
  })
  it('reads selection only after sensitive ancestor and intersected-range checks and enforces exact UTF-8 JSON budget', async () => {
    const f = fixture(bundle('<p>你好😀 "quote"</p><input type="password" value="SECRET"><textarea>SECRET</textarea><div contenteditable><span>SECRET</span></div>'))
    const { child } = f.connect(); f.load(); await f.boot
    const select = (node: Node) => {
      const range = child.window.document.createRange(); range.selectNodeContents(node)
      const selected = child.window.getSelection()!; selected.removeAllRanges(); selected.addRange(range)
    }
    const p = child.window.document.querySelector('p')!
    select(p)
    const expected = { text: p.textContent }
    const exact = new TextEncoder().encode(JSON.stringify(expected)).byteLength
    expect(await f.command({ kind: 'selection', maxBytes: exact })).toEqual(expected)
    expect(await f.command({ kind: 'selection', maxBytes: exact - 1 })).toEqual({ code: 'too-large' })
    for (const selector of ['textarea', 'div span', 'input']) {
      select(child.window.document.querySelector(selector)!)
      expect(await f.command({ kind: 'selection', maxBytes: 65536 })).toEqual({ code: 'empty-selection' })
    }
    select(p)
    const password = child.window.document.querySelector('input')!
    Object.defineProperty(password, 'value', { get() { throw new Error('must never read password value') } })
    password.focus()
    expect(await f.command({ kind: 'selection', maxBytes: 65536 })).toEqual({ code: 'empty-selection' })
    password.blur()
    const range = child.window.document.createRange(); range.setStart(p.firstChild!, 0); range.setEndAfter(child.window.document.querySelector('textarea')!)
    const selected = child.window.getSelection()!; selected.removeAllRanges(); selected.addRange(range)
    expect(await f.command({ kind: 'selection', maxBytes: 65536 })).toEqual({ code: 'empty-selection' })
    f.dispose()
  })
  it('allows no code or disk-reading messages and binds child broker requests to parent and document id', async () => {
    const f = fixture(); const { child } = f.connect(); f.load(); await f.boot
    const post = vi.mocked(f.shell.window.postMessage)
    const before = post.mock.calls.length
    const data = { documentId: id, requestId: 'forged', type: 'command', command: { kind: 'selection', maxBytes: 100 } }
    for (const [payload, source] of [[data, child.window], [{ ...data, documentId: 'wrong' }, f.shell.window], [{ ...data, command: { kind: 'eval', script: 'window.EVIL=true' } }, f.shell.window], [{ ...data, command: { kind: 'readFile', path: 'C:/private' } }, f.shell.window]] as const) {
      child.window.dispatchEvent(new child.window.MessageEvent('message', { data: payload, source }))
    }
    expect(post.mock.calls).toHaveLength(before)
    expect(Reflect.get(child.window, 'EVIL')).toBeUndefined()
    child.window.dispatchEvent(new child.window.Event('pagehide'))
    expect(await f.command({ kind: 'status' })).toMatchObject({ ready: false })
    f.message(ready)
    expect(await f.command({ kind: 'status' })).toMatchObject({ ready: false })
    f.dispose()
  })
  it('rejects a complete command script that exceeds the owning document budget', async () => {
    const f = fixture(); f.message(ready); f.load(); await f.boot
    const before = f.frameWindow.postMessage.mock.calls.length
    expect(await f.command({ kind: 'pick', nonce: 'big', instruction: '你好'.repeat(limits.maxBytes), maxBytes: 100 })).toEqual({ code: 'too-large' })
    expect(f.frameWindow.postMessage.mock.calls).toHaveLength(before)
    f.dispose()
  })
  it.each(['<script>unclosed </not-script>', '<!-- unclosed comment', '<textarea>unclosed </script>', '<plaintext>unclosed </script>'])('keeps malformed user markup inside encoded payload: %s', html => {
    const f = fixture(bundle(html))
    const source = f.frame.srcdoc
    const initial = new JSDOM(source)
    expect(initial.window.document.scripts).toHaveLength(1)
    expect(initial.window.document.scripts[0]!.textContent).not.toContain(html)
    initial.window.close(); f.dispose()
  })
  it('base64-packs hostile HTML and assets, replaces only exact declared references, and never puts file identity in the frame', async () => {
    const html = '<script src="a.js"></script><link rel="stylesheet" href="a.css"><img src="a.png"><img src="other.png"><p>"</script><script>window.EVIL=true</script>你好</p>'
    const input = { ...bundle(html), assets: [
      { reference: 'a.js', kind: 'script' as const, mimeType: 'text/javascript', bytes: new TextEncoder().encode('window.asset="</script>"') },
      { reference: 'a.css', kind: 'stylesheet' as const, mimeType: 'text/css', bytes: new TextEncoder().encode('p {color:red}') },
      { reference: 'a.png', kind: 'image' as const, mimeType: 'image/png', bytes: new Uint8Array([0, 255, 1]) },
    ] }
    const f = fixture(input)
    expect(f.frame.srcdoc).not.toContain(html)
    const initialDoc = new JSDOM(f.frame.srcdoc)
    expect(initialDoc.window.document.scripts).toHaveLength(1); initialDoc.window.close()
    expect(f.frame.srcdoc).not.toContain(input.source.path)
    const { child, blob, broker } = f.connect(); f.load(); await f.boot
    expect(blob).toHaveBeenCalledTimes(3)
    for (const selector of ['script[src]', 'link', 'img']) expect(child.window.document.querySelector(selector)?.getAttribute(selector === 'link' ? 'href' : 'src')).toBe('blob:null/authorized-fixture')
    expect(child.window.document.querySelectorAll('img')[1]!.getAttribute('src')).toBe('other.png')
    expect(Reflect.get(child.window, 'EVIL')).toBeUndefined()
    expect(broker).not.toMatch(/C:\/private|cwd:\/file|authorized-v1|executeJavaScript|readFile/)
    f.dispose()
  })
  it('refuses complete serialized payload/script and asset-count overflow without truncation, and rejects unknown commands', () => {
    const input = bundle('"你好😀"'.repeat(100))
    const source = localHtmlBootstrapScript(input, id, url, limits)
    const exact = new TextEncoder().encode(source).byteLength
    // The limit is serialized into the script itself, so find a stable exact-size fixed point.
    let bound = exact
    for (let index = 0; index < 3; index++) bound = new TextEncoder().encode(localHtmlBootstrapScript(input, id, url, { ...limits, maxBytes: bound + 100 })).byteLength
    expect(() => localHtmlBootstrapScript(input, id, url, { ...limits, maxBytes: bound - 1 })).toThrowError(expect.objectContaining({ code: 'limit' }))
    expect(() => localHtmlBootstrapScript(bundle('你好'.repeat(1000)), id, url, { ...limits, maxBytes: 100 })).toThrowError(expect.objectContaining({ code: 'limit' }))
    expect(() => localHtmlBootstrapScript({ ...input, assets: Array.from({ length: 11 }, () => ({ reference: 'x', kind: 'image', mimeType: 'image/png', bytes: new Uint8Array() })) }, id, url, limits)).toThrowError(expect.objectContaining({ code: 'limit' }))
    expect(() => localHtmlCommandScript(id, { kind: 'eval', script: 'evil()' } as never)).toThrowError(expect.objectContaining({ code: 'invalid' }))
    const script = localHtmlCommandScript('</script>"', { kind: 'pick', nonce: '</script>', instruction: '</script>你好', maxBytes: 100 })
    expect(script).not.toContain('</script>')
  })
})
