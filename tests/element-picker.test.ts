import { afterEach, describe, expect, it, vi } from 'vitest'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { decodeElementPickerReply, elementPickerCancelScript as cancelScript, elementPickerCheckScript as checkScript, elementPickerScript } from '../src/readers/element-picker.ts'
import { NativePage } from '../src/browser/NativePage.ts'
import type { GuestLease, OwnedWebview } from '../src/browser/bridge.ts'

const nonce = 'fixture-operation'
const elementPickerCancelScript = cancelScript(nonce)
const elementPickerCheckScript = checkScript(nonce)
const budget = { maxTextBytes: 65536, maxImageBytes: 65536 }
const pages: NativePage[] = []
const doms: JSDOM[] = []
afterEach(async () => {
  await Promise.all(pages.splice(0).map(page => page.dispose()))
  for (const dom of doms.splice(0)) dom.window.close()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})
function fixture(html = '<a href="/activated" id="TOKEN" class="SECRET">Visible <span>你好</span></a>') {
  const dom = new JSDOM(html, { url: 'https://example.test/page', runScripts: 'outside-only' })
  doms.push(dom)
  Reflect.set(dom.window, 'TextEncoder', TextEncoder)
  const node = dom.window.document.body.firstElementChild!
  const bounds = { x: 10, y: 20, left: 10, top: 20, right: 110, bottom: 60, width: 100, height: 40, toJSON: () => ({}) }
  Object.defineProperty(node, 'getBoundingClientRect', { configurable: true, value: () => bounds })
  // JSDOM has no layout; each fixture element is rendered unless its computed style hides it.
  Object.defineProperty(dom.window.Element.prototype, 'getClientRects', { value: () => [bounds] })
  const evaluate = (source: string): unknown => runInContext(source, dom.getInternalVMContext())
  Object.defineProperty(dom.window.document, 'elementFromPoint', { configurable: true, writable: true, value: vi.fn(() => node) })
  const start = (bytes = 65536, operation = nonce) => evaluate(elementPickerScript('本地化指引', bytes, operation)) as Promise<unknown>
  const click = () => {
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: 15, clientY: 25 })
    const target = dom.window.document.documentElement.children[2] ?? node
    target.dispatchEvent(event)
    return event
  }
  return { dom, node, bounds, evaluate, start, click }
}
async function native() {
  vi.stubGlobal('__BROWSER_CONTEXT_DEFUDDLE__', '')
  vi.stubGlobal('crypto', { randomUUID: () => nonce })
  const f = fixture()
  const host = document.createElement('div'); host.id = `picker-${pages.length}`; document.body.append(host)
  const page = new NativePage({ acquire: async () => ({ lease: 'picker' as GuestLease, partition: 'own' }), release: async () => {}, onOpenRequested: () => () => {} }, async () => 'cwd:/own', 'https://app.test')
  pages.push(page)
  page.mount(host.id, new AbortController().signal, undefined, () => {})
  page.loadUrl('https://example.test/page')
  await vi.waitFor(() => expect(host.querySelector('webview')).not.toBeNull())
  const guest = host.querySelector('webview') as OwnedWebview
  const execute = vi.fn(async (source: string): Promise<unknown> => f.evaluate(source))
  const capture = vi.fn(async () => ({ toDataURL: () => 'data:image/png;base64,iVBORw==' }))
  Object.assign(guest, { getURL: () => 'https://example.test/page', getTitle: () => 'Title', isLoading: () => false,
    loadURL: async () => {}, executeJavaScript: execute, capturePage: capture })
  guest.dispatchEvent(new Event('dom-ready'))
  return { ...f, page, guest, execute, capture }
}

describe('fixed element picker guest', () => {
  it('highlights, prevents activation, preserves business DOM and releases every listener', async () => {
    const f = fixture()
    const before = f.dom.window.document.body.innerHTML
    const pageClick = vi.fn(); f.node.addEventListener('click', pageClick)
    const result = f.start()
    f.node.dispatchEvent(new f.dom.window.MouseEvent('mousemove', { bubbles: true }))
    expect(f.dom.window.document.documentElement.lastElementChild?.textContent).toBe('本地化指引')
    expect(f.click().defaultPrevented).toBe(true)
    const raw = await result
    const picked = decodeElementPickerReply(raw, budget.maxTextBytes)
    expect(picked).toMatchObject({ tag: 'a', text: 'Visible 你好', selector: 'html:nth-of-type(1) > body:nth-of-type(1) > a:nth-of-type(1)' })
    expect(JSON.stringify(raw)).not.toMatch(/TOKEN|SECRET/)
    expect(pageClick).not.toHaveBeenCalled()
    expect(f.dom.window.document.body.innerHTML).toBe(before)
    expect(f.dom.window.document.documentElement.children.length).toBe(2)
    f.evaluate(elementPickerCancelScript)
    expect(f.evaluate('window.__dshReferenceElementPicker')).toBeUndefined()
    expect(f.click().defaultPrevented).toBe(false)
    expect(pageClick).toHaveBeenCalledOnce()
  })
  it('targets its transparent shield even for earlier window capture handlers, and only reads the element underneath', async () => {
    const f = fixture('<button>真实按钮</button>')
    const early = vi.fn((event: Event) => { if (event.target === f.node) throw new Error('Business target received the pointer') })
    const business = vi.fn()
    f.dom.window.addEventListener('click', early, true)
    f.node.addEventListener('click', business)
    const result = f.start()
    const shield = f.dom.window.document.documentElement.children[2] as HTMLElement
    expect(shield.style.pointerEvents).toBe('auto')
    expect(shield.style.cursor).toBe('crosshair')
    expect(shield.style.position).toBe('fixed')
    f.dom.window.document.elementFromPoint = vi.fn((x, y) => {
      expect([x, y]).toEqual([15, 25])
      expect(shield.style.pointerEvents).toBe('none')
      return f.node
    })
    shield.dispatchEvent(new f.dom.window.MouseEvent('mousemove', { bubbles: true, clientX: 15, clientY: 25 }))
    expect(shield.style.pointerEvents).toBe('auto')
    expect(f.click().defaultPrevented).toBe(true)
    expect(decodeElementPickerReply(await result, 65536)).toMatchObject({ tag: 'button', text: '真实按钮' })
    expect(early).toHaveBeenCalledOnce()
    expect(early.mock.calls[0]![0].target).toBe(shield)
    expect(business).not.toHaveBeenCalled()
    expect(shield.isConnected).toBe(false)
    expect(f.dom.window.document.documentElement.children.length).toBe(2)
    f.dom.window.removeEventListener('click', early, true)
    f.evaluate(elementPickerCancelScript)
  })
  it('suppresses pointer, mouse and keyboard actions until cleanup, then restores page handlers', async () => {
    const f = fixture()
    const types = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu', 'dblclick', 'keydown', 'keypress', 'keyup']
    const handlers = types.map(type => {
      const handler = vi.fn(); f.node.addEventListener(type, handler); return handler
    })
    const fire = (type: string) => {
      const event = type.startsWith('key')
        ? new f.dom.window.KeyboardEvent(type, { key: 'Enter', bubbles: true, cancelable: true })
        : new f.dom.window.MouseEvent(type, { bubbles: true, cancelable: true })
      f.node.dispatchEvent(event)
      return event
    }
    const result = f.start()
    for (const type of types) expect(fire(type).defaultPrevented).toBe(true)
    for (const handler of handlers) expect(handler).not.toHaveBeenCalled()
    f.click(); await result
    for (const type of types) expect(fire(type).defaultPrevented).toBe(false)
    for (const handler of handlers) expect(handler).toHaveBeenCalledOnce()
    f.evaluate(elementPickerCancelScript)
  })
  it('cancels with real Escape and supports repeated entry without overlay accumulation', async () => {
    const f = fixture()
    for (let i = 0; i < 3; i++) {
      const result = f.start()
      f.dom.window.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
      expect(await result).toEqual({ code: 'cancelled' })
      expect(f.dom.window.document.documentElement.children.length).toBe(2)
      expect(f.click().defaultPrevented).toBe(false)
    }
    const result = f.start(); f.evaluate(elementPickerCancelScript)
    expect(await result).toEqual({ code: 'cancelled' })
  })
  it.each(['<input type="password" value="SECRET" aria-label="SECRET">', '<textarea aria-label="SECRET">SECRET</textarea>', '<select aria-label="SECRET"><option>SECRET</option></select>', '<div contenteditable="true" aria-label="SECRET"><span>SECRET</span></div>'])('never samples form values or editable text: %s', async html => {
    const f = fixture(html)
    Object.defineProperty(f.node, 'value', { get() { throw new Error('form value read') } })
    const result = f.start(); f.click()
    const picked = decodeElementPickerReply(await result, budget.maxTextBytes)
    expect(picked.text).toBe(''); expect(picked.label).toBe(''); expect(picked.role).toBe('')
  })
  it('excludes sensitive and hidden descendants instead of using ancestor textContent', async () => {
    const f = fixture('<div>Public<textarea>SECRET</textarea><div contenteditable>SECRET</div><input value="SECRET"><span style="display:none">SECRET</span></div>')
    const result = f.start(); f.click()
    expect(decodeElementPickerReply(await result, 65536).text).toBe('Public')
  })
  it('does not read body/html text, iframe contents or shadow contents', async () => {
    for (const html of ['<body><p>BODY_SECRET</p></body>', '<iframe src="https://other.test"></iframe>', '<div></div>']) {
      const f = fixture(html)
      const target = html.startsWith('<body') ? f.dom.window.document.body : f.node
      if (html === '<div></div>') target.attachShadow({ mode: 'open' }).innerHTML = '<p>SHADOW_SECRET</p>'
      Object.defineProperty(target, 'getBoundingClientRect', { configurable: true, value: () => f.bounds })
      f.dom.window.document.elementFromPoint = () => target
      const result = f.start()
      f.click()
      expect(decodeElementPickerReply(await result, 65536).text).toBe('')
    }
  })
  it('counts the entire escaped UTF-8 reply JSON and refuses instead of truncating', async () => {
    const f = fixture('<div>你好😀 "quote"</div>')
    const initial = f.start(); f.click(); const raw = await initial
    const exact = new TextEncoder().encode(JSON.stringify(raw)).byteLength
    const good = f.start(exact); f.click(); expect(await good).toEqual(raw)
    const short = f.start(exact - 1); f.click(); expect(await short).toEqual({ code: 'too-large' })
    expect(() => decodeElementPickerReply(raw, exact - 1)).toThrowError(expect.objectContaining({ code: 'too-large' }))
  })
  it('does not let a stale operation cancel or inspect its successor', async () => {
    const f = fixture()
    const first = f.start(65536, 'old-operation')
    const second = f.start(65536, 'new-operation')
    expect(await first).toEqual({ code: 'cancelled' })
    f.evaluate(cancelScript('old-operation'))
    expect(f.evaluate(checkScript('old-operation'))).toEqual({ code: 'changed' })
    expect(f.dom.window.document.documentElement.children.length).toBe(5)
    expect(f.click().defaultPrevented).toBe(true)
    expect(decodeElementPickerReply(await second, 65536).tag).toBe('a')
    f.evaluate(cancelScript('old-operation'))
    expect(f.evaluate(checkScript('new-operation'))).toHaveProperty('element')
    f.evaluate(cancelScript('new-operation'))
    expect(f.evaluate('window.__dshReferenceElementPicker')).toBeUndefined()
  })
  it('remeasures only the original node and reports its removal', async () => {
    const f = fixture(); const initial = f.start(); f.click(); await initial
    f.node.remove()
    expect(f.evaluate(elementPickerCheckScript)).toEqual({ code: 'changed' })
  })
  it.each([{ x: NaN }, { width: 0 }, { x: -1 }, { x: 1000, width: 100 }])('rejects invalid bounds %j without exposing guest data', async rect => {
    const f = fixture(); const initial = f.start(); f.click(); const raw = await initial
    if (typeof raw !== 'object' || raw === null || !('element' in raw)) throw new Error('fixture reply')
    const picked = decodeElementPickerReply(raw, 65536)
    expect(() => decodeElementPickerReply({ element: { ...picked, rect: { ...picked.rect, ...rect } } }, 65536)).toThrowError(expect.objectContaining({ code: 'failed' }))
  })
})

describe('NativePage element capture ownership', () => {
  it('uses capturePage and checks the selected element before and after the native screenshot', async () => {
    const f = await native()
    const result = f.page.pickElement(budget, new AbortController().signal, '选择元素')
    f.click()
    expect(await result).toMatchObject({ image: { kind: 'viewport', mimeType: 'image/png' }, element: { tag: 'a' } })
    expect(f.capture).toHaveBeenCalledOnce()
    expect(f.execute.mock.calls.map(([source]) => source).slice(1)).toEqual([elementPickerCheckScript, elementPickerCheckScript, elementPickerCancelScript])
    expect(f.dom.window.document.documentElement.children.length).toBe(2)
  })
  it.each(['abort', 'navigate', 'close', 'escape'] as const)('settles a pending picker promptly on %s and cleans up', async action => {
    const f = await native(); const controller = new AbortController()
    const result = f.page.pickElement(budget, controller.signal, '选择元素')
    const rejected = expect(result).rejects.toMatchObject({ code: action === 'navigate' ? 'changed' : action === 'close' ? 'closed' : 'cancelled' })
    if (action === 'abort') controller.abort()
    if (action === 'navigate') f.guest.dispatchEvent(new Event('did-start-navigation'))
    if (action === 'close') await f.page.dispose()
    if (action === 'escape') f.dom.window.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: 'Escape' }))
    await rejected
    expect(f.capture).not.toHaveBeenCalled()
    expect(f.execute).toHaveBeenCalledWith(elementPickerCancelScript)
    expect(f.dom.window.document.documentElement.children.length).toBe(2)
  })
  it('cancels even when the original guest execution never settles', async () => {
    const f = await native(); const controller = new AbortController()
    f.execute.mockImplementationOnce(() => new Promise<never>(() => {}))
    const result = f.page.pickElement(budget, controller.signal, '选择元素')
    const rejected = expect(result).rejects.toMatchObject({ code: 'cancelled' })
    controller.abort()
    await rejected
    expect(f.execute).toHaveBeenCalledWith(elementPickerCancelScript)
    expect(f.capture).not.toHaveBeenCalled()
  })
  it.each(['dispose', 'destroy', 'navigate', 'same-url'] as const)('does not let unresolved cleanup block %s of an invalidated document', async action => {
    const f = await native()
    f.execute.mockImplementation(async () => new Promise<never>(() => {}))
    const result = f.page.pickElement(budget, new AbortController().signal, '选择元素')
    const rejected = expect(result).rejects.toMatchObject({ code: action === 'dispose' ? 'closed' : 'changed' })
    if (action === 'dispose') await f.page.dispose()
    else if (action === 'destroy') f.guest.dispatchEvent(new Event('destroyed'))
    else {
      if (action !== 'same-url') f.guest.getURL = () => 'https://example.test/other'
      f.guest.dispatchEvent(new Event('did-navigate'))
    }
    await rejected
    if (action === 'same-url') await f.page.dispose()
    expect(f.execute).toHaveBeenCalledWith(elementPickerCancelScript)
    expect(f.capture).not.toHaveBeenCalled()
  })
  it('rejects an already cancelled caller without injecting a picker', async () => {
    const f = await native(); const controller = new AbortController(); controller.abort()
    await expect(f.page.pickElement(budget, controller.signal, '')).rejects.toMatchObject({ code: 'cancelled' })
    expect(f.execute).not.toHaveBeenCalled()
  })
  it('rejects concurrent calls, then permits cancellation and re-entry', async () => {
    const f = await native(); const controller = new AbortController()
    const first = f.page.pickElement(budget, controller.signal, '选择元素')
    const rejected = expect(first).rejects.toMatchObject({ code: 'cancelled' })
    await expect(f.page.pickElement(budget, new AbortController().signal, '选择元素')).rejects.toMatchObject({ code: 'unavailable' })
    controller.abort(); await rejected
    const second = f.page.pickElement(budget, new AbortController().signal, '选择元素'); f.click()
    await expect(second).resolves.toMatchObject({ element: { tag: 'a' } })
  })
  it.each(['scroll', 'size', 'node'] as const)('rejects %s changes during native capture', async kind => {
    const f = await native()
    f.capture.mockImplementation(async () => {
      if (kind === 'scroll') Reflect.set(f.dom.window, 'scrollY', 1)
      if (kind === 'size') Reflect.set(f.dom.window, 'innerWidth', 900)
      if (kind === 'node') f.bounds.right++
      return { toDataURL: () => 'data:image/png;base64,iVBORw==' }
    })
    const result = f.page.pickElement(budget, new AbortController().signal, '选择元素'); f.click()
    await expect(result).rejects.toMatchObject({ code: 'changed' })
  })
  it('rejects invalid budgets, oversized image metadata and hostile guest replies', async () => {
    const f = await native()
    await expect(f.page.pickElement({ ...budget, maxTextBytes: -1 }, new AbortController().signal, '')).rejects.toMatchObject({ code: 'invalid-limit' })
    const result = f.page.pickElement({ ...budget, maxImageBytes: 4 }, new AbortController().signal, '选择元素'); f.click()
    await expect(result).rejects.toMatchObject({ code: 'too-large' })
    f.execute.mockImplementationOnce(async () => ({ element: { text: 'PRIVATE_DATA' } }))
    await expect(f.page.pickElement(budget, new AbortController().signal, '')).rejects.toMatchObject({ code: 'failed', message: 'Reference browser capture: failed' })
  })
})
