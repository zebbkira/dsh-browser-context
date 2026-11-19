/** Read-only guest picker and validation of its untrusted replies. */
import type { PickedElement } from '../browser/annotation.ts'
import { CaptureError } from '../browser/capture.ts'

interface PickerWindow extends Window { __dshReferenceElementPicker?: unknown }

function pickerGuest(instruction: string, maxBytes: number, nonce: string): Promise<object> {
  const key = '__dshReferenceElementPicker'
  const scope: PickerWindow = window
  const previous = scope[key]
  if (typeof previous === 'object' && previous !== null && 'cancel' in previous && typeof previous.cancel === 'function') previous.cancel()
  return new Promise(resolve => {
    const shield = document.createElement('div')
    shield.style.cssText = 'position:fixed;inset:0;pointer-events:auto;cursor:crosshair;z-index:2147483646;background:transparent'
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #2684ff;box-sizing:border-box;display:none;background:rgba(38,132,255,.12)'
    const hint = document.createElement('div')
    hint.textContent = instruction
    hint.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;top:8px;left:8px;max-width:80vw;padding:8px;background:#18202c;color:white;font:14px sans-serif'
    document.documentElement.append(shield, overlay, hint)
    const underneath = (event: MouseEvent): Element | null => {
      shield.style.pointerEvents = 'none'
      try {
        const node = document.elementFromPoint(event.clientX, event.clientY)
        return node === shield || node === overlay || node === hint ? null : node
      } finally { shield.style.pointerEvents = 'auto' }
    }
    let selected: Element | undefined
    let finished = false
    const viewport = () => ({ width: innerWidth, height: innerHeight, scrollX, scrollY })
    const blocked = (node: Element): boolean => {
      for (let current: Element | null = node; current; current = current.parentElement) {
        if (/^(input|textarea|select|option|script|style|noscript)$/i.test(current.localName)
          || (current.hasAttribute('contenteditable') && current.getAttribute('contenteditable') !== 'false')) return true
      }
      return false
    }
    const describe = (node: Element) => {
      const bounds = node.getBoundingClientRect()
      const x = Math.max(0, bounds.left), y = Math.max(0, bounds.top)
      const rect = { x, y, width: Math.min(innerWidth, bounds.right) - x, height: Math.min(innerHeight, bounds.bottom) - y }
      const parts: string[] = []
      for (let current: Element | null = node; current; current = current.parentElement) {
        let index = 1
        for (let sibling = current.previousElementSibling; sibling; sibling = sibling.previousElementSibling) if (sibling.localName === current.localName) index++
        parts.unshift(`${current.localName}:nth-of-type(${index})`)
      }
      const texts: string[] = []
      const collect = (element: Element): void => {
        if (blocked(element)) return
        const style = getComputedStyle(element)
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0'
          || element.getClientRects().length === 0) return
        for (const child of element.childNodes) {
          if (child.nodeType === Node.TEXT_NODE) texts.push(child.textContent || '')
          else if (child instanceof Element) collect(child)
        }
      }
      const sensitive = blocked(node) || /^(html|body)$/.test(node.localName)
      if (!sensitive && !/^(html|body)$/i.test(node.localName)) collect(node)
      const role = sensitive ? '' : node.getAttribute('role') || ''
      return { tag: node.localName, selector: parts.join(' > '), role: /^(button|link|heading|img|list|listitem|navigation|main|article|region|dialog|tab|tabpanel|checkbox|radio|switch|menu|menuitem|table|row|cell)$/.test(role) ? role : '',
        label: sensitive ? '' : node.getAttribute('aria-label') || '', text: texts.join(' ').replace(/\s+/g, ' ').trim(), rect, viewport: viewport() }
    }
    const suppressedEvents = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'contextmenu', 'dblclick', 'keypress', 'keyup']
    const suppress = (event: Event): void => { event.preventDefault(); event.stopImmediatePropagation() }
    const remove = () => {
      shield.remove(); overlay.remove(); hint.remove()
      for (const type of suppressedEvents) window.removeEventListener(type, suppress, true)
      window.removeEventListener('mousemove', hover, true)
      window.removeEventListener('click', click, true)
      window.removeEventListener('keydown', keyboard, true)
      window.removeEventListener('pagehide', cancel, true)
    }
    const finish = (reply: object) => { if (finished) return; finished = true; remove(); resolve(reply) }
    const cancel = () => { finish({ code: 'cancelled' }); if (scope[key] === state) delete scope[key] }
    const check = () => selected?.isConnected ? { element: describe(selected) } : { code: 'changed' }
    const state = { nonce, cancel, check }
    const hover = (event: MouseEvent) => {
      const node = underneath(event)
      if (!(node instanceof Element)) { overlay.style.display = 'none'; return }
      const rect = node.getBoundingClientRect()
      overlay.style.display = 'block'
      overlay.style.left = `${rect.left}px`; overlay.style.top = `${rect.top}px`
      overlay.style.width = `${rect.width}px`; overlay.style.height = `${rect.height}px`
    }
    const click = (event: MouseEvent) => {
      event.preventDefault(); event.stopImmediatePropagation()
      try {
        const node = underneath(event)
        if (!(node instanceof Element)) { finish({ code: 'failed' }); return }
        selected = node
        const reply = check()
        finish(new TextEncoder().encode(JSON.stringify(reply)).byteLength > maxBytes ? { code: 'too-large' } : reply)
      } catch (_error) { finish({ code: 'failed' }) }
    }
    const keyboard = (event: KeyboardEvent) => {
      suppress(event)
      if (event.key === 'Escape') cancel()
    }
    scope[key] = state
    for (const type of suppressedEvents) window.addEventListener(type, suppress, true)
    window.addEventListener('mousemove', hover, true)
    window.addEventListener('click', click, true)
    window.addEventListener('keydown', keyboard, true)
    window.addEventListener('pagehide', cancel, true)
  })
}

/** @returns existing self-contained picker function source for the opaque local-document broker; accepts no caller code. */
export function elementPickerGuestSource(): string { return pickerGuest.toString() }

/** @param instruction - localized host text. @param maxBytes - complete reply JSON budget. @param nonce - unique operation identity. @returns fixed self-contained guest script. */
export function elementPickerScript(instruction: string, maxBytes: number, nonce: string): string {
  return `(${pickerGuest.toString()})(${JSON.stringify(instruction)},${JSON.stringify(maxBytes)},${JSON.stringify(nonce)})`
}

/** @param nonce - operation to clean up, never a successor. @returns fixed cleanup for that guest operation and selection reference. */
export function elementPickerCancelScript(nonce: string): string {
  return `(() => { const state = window.__dshReferenceElementPicker; if (state && state.nonce === ${JSON.stringify(nonce)} && typeof state.cancel === 'function') state.cancel(); })()`
}
/** @param nonce - operation whose selected node is remeasured. @returns fixed script that never queries a caller selector. */
export function elementPickerCheckScript(nonce: string): string {
  return `(() => { const state = window.__dshReferenceElementPicker; return state && state.nonce === ${JSON.stringify(nonce)} && typeof state.check === 'function' ? state.check() : { code: 'changed' }; })()`
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) }

/** @param raw - untrusted guest output. @param maxBytes - complete reply JSON budget. @returns validated plain selection, without extra guest fields. */
export function decodeElementPickerReply(raw: unknown, maxBytes: number): PickedElement {
  if (!record(raw)) throw new CaptureError('failed')
  if (raw.code === 'cancelled' || raw.code === 'too-large' || raw.code === 'changed' || raw.code === 'failed') throw new CaptureError(raw.code)
  let size: number
  try { size = new TextEncoder().encode(JSON.stringify(raw)).byteLength } catch (_error) { throw new CaptureError('failed') }
  if (size > maxBytes) throw new CaptureError('too-large')
  const e = raw.element
  if (!record(e) || typeof e.tag !== 'string' || !/^[a-z][a-z0-9-]*$/.test(e.tag)
    || typeof e.selector !== 'string' || !/^[a-z][a-z0-9-]*:nth-of-type\([1-9][0-9]*\)( > [a-z][a-z0-9-]*:nth-of-type\([1-9][0-9]*\))*$/.test(e.selector)
    || typeof e.role !== 'string' || typeof e.label !== 'string' || typeof e.text !== 'string'
    || !record(e.rect) || !record(e.viewport)) throw new CaptureError('failed')
  const r = e.rect, v = e.viewport
  if (!finite(v.width) || !finite(v.height) || v.width <= 0 || v.height <= 0 || !finite(v.scrollX) || !finite(v.scrollY)
    || !finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height) || r.x < 0 || r.y < 0 || r.width <= 0 || r.height <= 0
    || r.x + r.width > v.width || r.y + r.height > v.height) throw new CaptureError('failed')
  if (/^(input|textarea|select|option|html|body)$/.test(e.tag) && (e.text !== '' || e.label !== '' || e.role !== '')) throw new CaptureError('failed')
  return { tag: e.tag, selector: e.selector, role: e.role, label: e.label, text: e.text,
    rect: { x: r.x, y: r.y, width: r.width, height: r.height }, viewport: { width: v.width, height: v.height, scrollX: v.scrollX, scrollY: v.scrollY } }
}
