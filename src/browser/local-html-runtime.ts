/** Memory-only local-document scripts. The lease shell owns an opaque frame, never file authority. */
import { elementPickerGuestSource } from '../readers/element-picker.ts'
import { LocalHtmlError, type LocalHtmlBundle, type LocalHtmlCommand, type LocalHtmlLimits } from './local-html-types.ts'

type Reply = Record<string, unknown>
interface PackedDocument { html: string; assets: { reference: string; kind: string; mimeType: string; bytes: string }[] }
interface LocalState {
  documentId: string
  invoke(command: LocalHtmlCommand, scriptBytes: number): Promise<Reply | boolean>
  dispose(): void
}
interface ShellWindow extends Window { __dshLocalHtmlRuntime?: LocalState }
interface PickerState { nonce: string; cancel(): void; check(): object }
interface BrokerWindow extends Window { __dshReferenceElementPicker?: PickerState }

function base64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
function literal(value: unknown): string { return JSON.stringify(value).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029') }
function bytes(value: string): number { return new TextEncoder().encode(value).byteLength }
function bounded(source: string, maxBytes: number): string {
  if (bytes(source) > maxBytes) throw new LocalHtmlError('limit')
  return source
}

// Serialized verbatim; every dependency is an argument or a browser primitive.
function broker(documentId: string, maxBytes: number, picker: (instruction: string, maxBytes: number, nonce: string) => Promise<object>): void {
  const scope: BrokerWindow = window
  const budgets = new Map<string, number>()
  const size = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).byteLength
  const send = (requestId: string, value: unknown): void => { parent.postMessage({ documentId, requestId, type: 'reply', value }, '*') }
  const cancel = (nonce: string): void => {
    const state = scope.__dshReferenceElementPicker
    if (state?.nonce === nonce) state.cancel()
    budgets.delete(nonce)
  }
  const protectedNode = (node: Node | null): boolean => {
    let element = node instanceof Element ? node : node?.parentElement
    while (element) {
      if (/^(input|textarea|select|option|script|style|noscript)$/i.test(element.localName)
        || (element.hasAttribute('contenteditable') && element.getAttribute('contenteditable') !== 'false')) return true
      element = element.parentElement
    }
    return false
  }
  const selection = (budget: number): Reply => {
    if (protectedNode(document.activeElement)) return { code: 'empty-selection' }
    const selected = window.getSelection()
    if (!selected || selected.isCollapsed || protectedNode(selected.anchorNode) || protectedNode(selected.focusNode)) return { code: 'empty-selection' }
    const sensitive = document.querySelectorAll('input,textarea,select,option,script,style,noscript,[contenteditable]')
    for (let index = 0; index < selected.rangeCount; index++) {
      const range = selected.getRangeAt(index)
      if (protectedNode(range.commonAncestorContainer)) return { code: 'empty-selection' }
      for (const node of sensitive) {
        if (protectedNode(node) && range.intersectsNode(node)) return { code: 'empty-selection' }
      }
    }
    const text = selected.toString().trim()
    const reply = text ? { text } : { code: 'empty-selection' }
    return size(reply) > budget ? { code: 'too-large' } : reply
  }
  const receive = async (event: MessageEvent): Promise<void> => {
    if (event.source !== parent) return
    const data = event.data
    if (!data || data.documentId !== documentId || data.type !== 'command' || typeof data.requestId !== 'string') return
    const command = data.command
    if (!command || typeof command !== 'object') return
    const requestId = data.requestId
    try {
      let value: unknown
      switch (command.kind) {
        case 'selection':
          if (!Number.isSafeInteger(command.maxBytes) || command.maxBytes <= 0 || command.maxBytes > maxBytes) { value = { code: 'failed' }; break }
          value = selection(command.maxBytes)
          break
        case 'pick':
          if (typeof command.nonce !== 'string' || typeof command.instruction !== 'string'
            || !Number.isSafeInteger(command.maxBytes) || command.maxBytes <= 0 || command.maxBytes > maxBytes) { value = { code: 'failed' }; break }
          budgets.clear()
          budgets.set(command.nonce, command.maxBytes)
          value = await picker(command.instruction, command.maxBytes, command.nonce)
          if (size(value) > command.maxBytes) value = { code: 'too-large' }
          break
        case 'check': {
          if (typeof command.nonce !== 'string') { value = { code: 'failed' }; break }
          const state = scope.__dshReferenceElementPicker
          const budget = budgets.get(command.nonce)
          value = state && state.nonce === command.nonce && budget !== undefined ? state.check() : { code: 'changed' }
          if (budget !== undefined && size(value) > budget) value = { code: 'too-large' }
          break
        }
        case 'cancel':
          if (typeof command.nonce !== 'string') { value = { code: 'failed' }; break }
          cancel(command.nonce); value = true
          break
        default: return
      }
      send(requestId, value)
    } catch (_error) { send(requestId, { code: 'failed' }) }
  }
  window.addEventListener('message', receive)
  window.addEventListener('pagehide', () => {
    scope.__dshReferenceElementPicker?.cancel()
    window.removeEventListener('message', receive)
    parent.postMessage({ documentId, requestId: 'bootstrap', type: 'gone' }, '*')
  }, { once: true })
  parent.postMessage({ documentId, requestId: 'bootstrap', type: 'ready' }, '*')
}

function frameBootstrap(encoded: string, brokerSource: string): void {
  try {
    const raw = Uint8Array.from(atob(encoded), character => character.charCodeAt(0))
    const packed: PackedDocument = JSON.parse(new TextDecoder().decode(raw))
    const parsed = new DOMParser().parseFromString(packed.html, 'text/html')
    for (const asset of packed.assets) {
      const selector = asset.kind === 'script' ? 'script[src]' : asset.kind === 'stylesheet' ? 'link[href]' : 'img[src]'
      const attribute = asset.kind === 'stylesheet' ? 'href' : 'src'
      const content = Uint8Array.from(atob(asset.bytes), character => character.charCodeAt(0))
      const url = URL.createObjectURL(new Blob([content], { type: asset.mimeType }))
      for (const node of parsed.querySelectorAll(selector)) {
        if (node.getAttribute(attribute) === asset.reference
          && (asset.kind !== 'stylesheet' || node.getAttribute('rel')?.toLowerCase().split(/\s+/).includes('stylesheet'))) node.setAttribute(attribute, url)
      }
    }
    const script = parsed.createElement('script')
    script.textContent = brokerSource
    parsed.body.append(script)
    const html = '<!doctype html>' + parsed.documentElement.outerHTML
    document.open(); document.write(html); document.close()
  } catch (_error) {
    // No user bytes or exception text crosses back into the trusted lease shell.
  }
}

function shellBootstrap(documentId: string, expectedUrl: string, limits: LocalHtmlLimits, srcdoc: string): Promise<Reply> {
  if (location.href !== expectedUrl || !/^about:blank(?:#.*)?$/.test(location.href)) return Promise.resolve({ code: 'frame' })
  const scope: ShellWindow = window
  scope.__dshLocalHtmlRuntime?.dispose()
  return new Promise(resolveBootstrap => {
    const frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-scripts')
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;display:block'
    document.documentElement.style.margin = '0'; document.body.style.margin = '0'
    let generation = 0, readyMessage = false, ready = false, closed = false, invalidated = false
    let sequence = 0, bootstrapSettled = false
    const pending = new Map<string, { resolve(value: Reply | boolean): void; timer?: number; kind: string; nonce?: string; budget: number }>()
    const budgets = new Map<string, number>()
    const status = (): Reply => ({ documentId, frameGeneration: generation, ready, viewport: { width: innerWidth, height: innerHeight } })
    const settleBootstrap = (value: Reply): void => {
      if (bootstrapSettled) return
      bootstrapSettled = true; clearTimeout(bootstrapTimer); resolveBootstrap(value)
    }
    const settle = (requestId: string, value: Reply | boolean): void => {
      const operation = pending.get(requestId)
      if (!operation) return
      clearTimeout(operation.timer); pending.delete(requestId); operation.resolve(value)
    }
    const send = (requestId: string, command: LocalHtmlCommand): void => {
      frame.contentWindow?.postMessage({ documentId, requestId, type: 'command', command }, '*')
    }
    const invalidate = (code: string): void => {
      ready = false; invalidated = true
      for (const [requestId, operation] of pending) {
        if (operation.nonce) send(`cleanup-${++sequence}`, { kind: 'cancel', nonce: operation.nonce })
        settle(requestId, { code })
      }
      budgets.clear(); settleBootstrap({ code })
    }
    const receive = (event: MessageEvent): void => {
      if (closed || event.source !== frame.contentWindow) return
      const data = event.data
      if (!data || data.documentId !== documentId || typeof data.requestId !== 'string') return
      if (data.requestId === 'bootstrap') {
        if (data.type === 'gone') { invalidate('changed'); return }
        if (data.type === 'ready' && !invalidated) { readyMessage = true; complete() }
        return
      }
      if (data.type !== 'reply' || !ready) return
      const operation = pending.get(data.requestId)
      if (!operation) return
      try {
        const raw = data.value
        if (!raw || typeof raw !== 'object') { settle(data.requestId, { code: 'failed' }); return }
        let value: Reply
        const allowedCodes = operation.kind === 'selection' ? ['empty-selection', 'too-large', 'failed'] : ['too-large', 'failed', 'changed', 'cancelled']
        if (typeof raw.code === 'string' && allowedCodes.includes(raw.code)) value = { code: raw.code }
        else if (operation.kind === 'selection' && typeof raw.text === 'string') value = { text: raw.text }
        else if (operation.kind === 'pick' || operation.kind === 'check') value = { element: raw.element }
        else value = { code: 'failed' }
        const size = new TextEncoder().encode(JSON.stringify(raw)).byteLength
        settle(data.requestId, size > operation.budget ? { code: 'too-large' } : value)
      } catch (_error) { settle(data.requestId, { code: 'failed' }) }
    }
    const complete = (): void => {
      if (!closed && !invalidated && generation === 1 && readyMessage) { ready = true; settleBootstrap(status()) }
    }
    const loaded = (): void => {
      generation++
      if (generation > 1) invalidate('changed')
      else complete()
    }
    const dispose = (): void => {
      if (closed) return
      for (const nonce of budgets.keys()) send(`cleanup-${++sequence}`, { kind: 'cancel', nonce })
      invalidate('closed'); closed = true
      window.removeEventListener('message', receive); window.removeEventListener('pagehide', dispose)
      frame.removeEventListener('load', loaded); frame.remove()
      if (scope.__dshLocalHtmlRuntime === state) delete scope.__dshLocalHtmlRuntime
    }
    const state: LocalState = { documentId, dispose, invoke: async (command, scriptBytes) => {
      if (closed) return { code: 'closed' }
      if (!Number.isSafeInteger(scriptBytes) || scriptBytes > limits.maxBytes
        || new TextEncoder().encode(JSON.stringify(command)).byteLength > limits.maxBytes) return { code: 'too-large' }
      if (command.kind === 'status') return status()
      if (command.kind === 'cancel') {
        if (typeof command.nonce !== 'string') return { code: 'failed' }
        send(`cleanup-${++sequence}`, command)
        for (const [requestId, operation] of pending) if (operation.nonce === command.nonce) settle(requestId, { code: 'cancelled' })
        budgets.delete(command.nonce)
        return true
      }
      if (!ready) return { code: 'changed' }
      if (!['selection', 'pick', 'check'].includes(command.kind)) return { code: 'failed' }
      if (command.kind === 'selection' || command.kind === 'pick') {
        if (!Number.isSafeInteger(command.maxBytes) || command.maxBytes <= 0 || command.maxBytes > limits.maxBytes) return { code: 'failed' }
      }
      if ((command.kind === 'pick' || command.kind === 'check') && typeof command.nonce !== 'string') return { code: 'failed' }
      if (command.kind === 'pick' && typeof command.instruction !== 'string') return { code: 'failed' }
      const budget = command.kind === 'check' ? budgets.get(command.nonce) : command.maxBytes
      if (budget === undefined) return { code: 'changed' }
      if (command.kind === 'pick') {
        frame.focus()
        for (const [requestId, operation] of pending) if (operation.kind === 'pick') settle(requestId, { code: 'cancelled' })
        budgets.clear(); budgets.set(command.nonce, budget)
      }
      const requestId = `request-${++sequence}`
      return new Promise<Reply | boolean>(resolve => {
        const timer = command.kind === 'pick' ? undefined : window.setTimeout(() => settle(requestId, { code: 'timeout' }), limits.timeoutMs)
        pending.set(requestId, { resolve, ...(timer === undefined ? {} : { timer }), kind: command.kind,
          ...(command.kind === 'selection' ? {} : { nonce: command.nonce }), budget })
        send(requestId, command)
      })
    } }
    const bootstrapTimer = window.setTimeout(() => { invalidate('timeout'); dispose() }, limits.timeoutMs)
    scope.__dshLocalHtmlRuntime = state
    window.addEventListener('message', receive); window.addEventListener('pagehide', dispose, { once: true })
    frame.addEventListener('load', loaded)
    frame.srcdoc = srcdoc
    document.body.append(frame)
  })
}

/**
 * @param bundle - complete host-authorized bytes; identity is never delegated to frame messages.
 * @param documentId - lease document identity.
 * @param expectedBootstrapUrl - exact about:blank lease URL; mismatches make no DOM changes.
 * @param limits - complete payload/script byte, asset-count and finite-request limits.
 * @returns self-contained Promise expression; failures are stable code-only replies. Pick is lifecycle-cancelled, not timed out.
 */
export function localHtmlBootstrapScript(bundle: LocalHtmlBundle, documentId: string, expectedBootstrapUrl: string, limits: LocalHtmlLimits): string {
  if (![limits.maxBytes, limits.maxFiles, limits.timeoutMs].every(value => Number.isSafeInteger(value) && value > 0)) throw new LocalHtmlError('config')
  if (bundle.assets.length > limits.maxFiles) throw new LocalHtmlError('limit')
  const packed: PackedDocument = { html: bundle.html, assets: bundle.assets.map(asset => ({ ...asset, bytes: base64(asset.bytes) })) }
  const payload = JSON.stringify(packed)
  bounded(payload, limits.maxBytes)
  const brokerSource = `(${broker.toString()})(${literal(documentId)},${limits.maxBytes},${elementPickerGuestSource()})`
  // HTML is encoded, never interpolated into a script body, including malformed closing tags.
  const initializer = `(${frameBootstrap.toString()})(${literal(base64(new TextEncoder().encode(payload)))},${literal(brokerSource)})`
  const srcdoc = `<!doctype html><html><head></head><body><script>${initializer}</script></body></html>`
  return bounded(`(${shellBootstrap.toString()})(${literal(documentId)},${literal(expectedBootstrapUrl)},${literal(limits)},${literal(srcdoc)})`, limits.maxBytes)
}

/** @param documentId - owning document, not file identity. @param command - fixed finite broker operation. @returns Promise expression with no caller-supplied executable code. */
export function localHtmlCommandScript(documentId: string, command: LocalHtmlCommand): string {
  switch (command.kind) {
    case 'status': case 'selection': case 'pick': case 'check': case 'cancel': break
    default: throw new LocalHtmlError('invalid')
  }
  const expression = (size: number): string => `(() => { const state = window.__dshLocalHtmlRuntime; return state && state.documentId === ${literal(documentId)} ? state.invoke(${literal(command)},${size}) : Promise.resolve({code:'closed'}); })()`
  let source = expression(0)
  for (;;) {
    const next = expression(bytes(source))
    if (next === source) return source
    source = next
  }
}

/** @param documentId - only this document's state may be disposed. @returns idempotent cleanup expression, settling all owned pending work before removal. */
export function localHtmlDisposeScript(documentId: string): string {
  return `(() => { const state = window.__dshLocalHtmlRuntime; if (state && state.documentId === ${literal(documentId)}) state.dispose(); return true; })()`
}
