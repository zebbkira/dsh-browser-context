/** Plugin-owned native guest. Lease/bootstrap rules follow stock DSH Desktop protocol 1 (MIT, DeepSeek). */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { BrowserBridge, GuestLease, OwnedWebview } from './bridge.ts'
import type { BrowserContextCapture, BrowserContextCaptureKind, BrowserContextCaptureLimits } from './contract.ts'
import { boundCapture, CaptureError, pngBytes, validateLimits } from './capture.ts'
import { selectionScript } from './selection.ts'
import { decodeWecomSelectionReply, wecomSelectionScript } from '../readers/wecom-selection.ts'
import { articleScript } from '../readers/article.ts'
import { bilibiliVideoScript, decodeBilibiliReply, isBilibiliVideo } from '../readers/bilibili.ts'
import { decodeWecomReply, isWecomDocument, wecomDocumentScript, wecomMinimumReplyBytes } from '../readers/wecom.ts'
import css from './View.module.css'

/** Reactive state of this plugin's own guest; no stock Browser controller or DOM is consulted. */
export interface PageState {
  readonly url: string | undefined
  readonly title: string
  readonly observed: boolean
  readonly loading: boolean
  readonly available: boolean
  readonly error: 'desktop-only' | 'invalid-address' | 'load-failed' | undefined
  readonly generation: number
}

function address(value: string, applicationOrigin: string): string | undefined {
  try {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`)
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.username === '' && url.password === ''
      && url.origin !== applicationOrigin ? url.href : undefined
  } catch (_error) { return undefined } // Address input is untrusted; do not navigate on parse failure.
}

/** Owns one tab's guest, asynchronous reservations, listeners and captures until explicit disposal. */
export class NativePage {
  private readonly state = createSnapshotStore<PageState>({ url: undefined, title: '', observed: false,
    loading: false, available: false, error: undefined, generation: 0 })
  private readonly lifetime = new AbortController()
  private attachment: { host: HTMLElement; life: AbortController } | undefined
  private occurrence: AbortSignal | undefined
  private element: OwnedWebview | undefined
  private guestLife: AbortController | undefined
  private lease: GuestLease | undefined
  private initializing: Promise<void> | undefined
  private disposal: Promise<void> | undefined
  private readonly releases = new Set<Promise<void>>()
  private pending: string | undefined
  private ready = false
  private readonly ended = (): void => { void this.dispose() }
  private openRequested: (url: string) => void = () => {}

  constructor(private readonly bridge: BrowserBridge | undefined,
    private readonly workspace: (signal: AbortSignal) => Promise<string>, private readonly applicationOrigin: string) {}

  /** @returns stable snapshot until an owned guest event or navigation changes it. */
  getSnapshot = (): PageState => this.state.getSnapshot()
  /** @param listener - frame invalidation observer. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener)

  /** @param hostId - own viewport id. @param signal - tab occurrence. @param initialUrl - explicit open URL. @param open - popup-to-own-tab callback. @returns physical mount cleanup. */
  mount(hostId: string, signal: AbortSignal, initialUrl: string | undefined, open: (url: string) => void): () => void {
    if (this.lifetime.signal.aborted || signal.aborted) return () => {}
    const host = document.getElementById(hostId)
    if (host === null) throw new Error('Reference browser viewport is not mounted')
    if (this.occurrence !== signal) {
      this.occurrence?.removeEventListener('abort', this.ended)
      this.occurrence = signal
      signal.addEventListener('abort', this.ended, { once: true })
    }
    this.detach()
    const attachment = { host, life: new AbortController() }
    this.attachment = attachment
    this.openRequested = open
    if (this.bridge === undefined) this.publish({ error: 'desktop-only' })
    else if (this.getSnapshot().url !== undefined) this.loadUrl(this.getSnapshot().url!)
    else if (initialUrl !== undefined) this.loadUrl(initialUrl)
    return () => { if (this.attachment === attachment) this.detach() }
  }

  /** @param value - explicit URL input; only HTTP(S), without credentials or the application origin. */
  loadUrl(value: string): void {
    if (this.lifetime.signal.aborted) return
    const url = address(value, this.applicationOrigin)
    if (url === undefined) { this.publish({ error: 'invalid-address' }); return }
    if (this.bridge === undefined) { this.publish({ error: 'desktop-only' }); return }
    this.pending = url
    this.publish({ url, title: new URL(url).hostname, observed: false, loading: true, error: undefined })
    if (this.ready) this.loadPending()
    else this.initialize()
  }

  /** Reload the owned URL; same-URL requests still invalidate every pending capture. */
  reload(): void { const url = this.getSnapshot().url; if (url !== undefined) this.loadUrl(url) }

  /** @param kind - semantic capture, never caller script. @param limits - complete output budget. @returns transient data from the same loaded document. */
  async capture(kind: BrowserContextCaptureKind, limits: BrowserContextCaptureLimits): Promise<BrowserContextCapture> {
    validateLimits(limits)
    if (this.lifetime.signal.aborted) throw new CaptureError('closed')
    if (this.bridge === undefined) throw new CaptureError('unsupported')
    const element = this.element
    const state = this.getSnapshot()
    if (element === undefined || !state.available || state.url === undefined) throw new CaptureError('unavailable')
    const assertCurrent = (): void => {
      if (this.lifetime.signal.aborted || this.occurrence?.aborted === true) throw new CaptureError('closed')
      if (this.element !== element || this.getSnapshot().generation !== state.generation) throw new CaptureError('changed')
      let url: string
      try { url = element.getURL() } catch (_error) { throw new CaptureError('changed') }
      if (url !== state.url) throw new CaptureError('changed')
    }
    try {
      assertCurrent()
      let result: BrowserContextCapture
      if (kind === 'selection') {
        if (isWecomDocument(state.url)) {
          const raw = await element.executeJavaScript(wecomSelectionScript(limits.maxBytes))
          assertCurrent()
          const reply = decodeWecomSelectionReply(raw)
          if ('code' in reply) {
            const detail = reply.selectionInfo === undefined ? '' : `\nselectionInfo: ${JSON.stringify(reply.selectionInfo)}`
            const cause = reply.stage === undefined ? undefined : new Error(`Melo selection stage: ${reply.stage}${detail}`)
            const code = reply.code === 'unsupported'
              ? reply.stage === 'selection' ? 'melo-range-unavailable' : 'melo-unavailable'
              : reply.code
            throw new CaptureError(code, { cause })
          }
          result = { kind, url: state.url, title: state.title, text: reply.text }
        } else {
          const reply = await element.executeJavaScript(selectionScript(limits.maxBytes))
          assertCurrent()
          if (typeof reply !== 'object' || reply === null) throw new CaptureError('failed')
          if ('code' in reply && (reply.code === 'empty-selection' || reply.code === 'too-large')) throw new CaptureError(reply.code)
          if (!('text' in reply) || typeof reply.text !== 'string') throw new CaptureError('failed')
          if (reply.text.length === 0) throw new CaptureError('empty-selection')
          result = { kind, url: state.url, title: state.title, text: reply.text }
        }
      } else if (kind === 'document') {
        if (!isWecomDocument(state.url)) throw new CaptureError('unsupported')
        if (limits.maxBytes < wecomMinimumReplyBytes) throw new CaptureError('too-large')
        const raw = await element.executeJavaScript(wecomDocumentScript(limits.maxBytes))
        assertCurrent()
        const reply = decodeWecomReply(raw)
        if (reply.status === 'too-large') throw new CaptureError('too-large')
        if (reply.status === 'no-document') {
          const diagnostic = JSON.stringify(reply.diagnostic)
          if (new TextEncoder().encode(diagnostic).byteLength > limits.maxBytes) throw new CaptureError('too-large')
          const cause = new Error(diagnostic)
          cause.name = 'WecomDocumentDiagnostic'
          throw new CaptureError('no-document', { cause })
        }
        if (reply.url !== state.url) throw new CaptureError('changed')
        if (reply.text.trim().length === 0) throw new CaptureError('no-document')
        result = { kind, url: state.url, title: reply.title || state.title, text: reply.text, format: 'text', coverage: 'loaded' }
      } else if (kind === 'video') {
        if (!isBilibiliVideo(state.url)) throw new CaptureError('unsupported')
        const timeout = limits.subtitleRequestTimeoutMs
        if (timeout === undefined || !Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2147483647) throw new CaptureError('invalid-limit')
        const raw = await element.executeJavaScript(bilibiliVideoScript(limits.maxBytes, timeout))
        assertCurrent()
        const reply = decodeBilibiliReply(raw)
        if ('code' in reply) throw new CaptureError(reply.code)
        if (reply.url !== state.url) throw new CaptureError('changed')
        result = { ...reply }
      } else if (kind === 'article') {
        if (isWecomDocument(state.url) || isBilibiliVideo(state.url)) throw new CaptureError('unsupported')
        const reply = await element.executeJavaScript(articleScript(limits.maxBytes))
        assertCurrent()
        if (typeof reply !== 'object' || reply === null) throw new CaptureError('failed')
        if ('code' in reply && (reply.code === 'no-article' || reply.code === 'too-large')) throw new CaptureError(reply.code)
        if (!('kind' in reply) || reply.kind !== 'article' || !('format' in reply) || reply.format !== 'markdown'
          || !('url' in reply) || reply.url !== state.url || !('title' in reply) || typeof reply.title !== 'string'
          || !('text' in reply) || typeof reply.text !== 'string') throw new CaptureError('failed')
        if (reply.text.trim().length === 0) throw new CaptureError('no-article')
        result = { kind, url: state.url, title: reply.title, text: reply.text, format: 'markdown' }
      } else {
        const image = await element.capturePage()
        assertCurrent()
        result = { kind, url: state.url, title: state.title, mimeType: 'image/png', bytes: pngBytes(image.toDataURL(), limits.maxBytes) }
      }
      return boundCapture(result, limits)
    } catch (error) {
      assertCurrent()
      if (error instanceof CaptureError) throw error
      throw new CaptureError('failed')
    }
  }

  /** @returns after acquisition and all owned guest releases settle; repeated callers join the same disposal. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.lifetime.abort()
    this.occurrence?.removeEventListener('abort', this.ended)
    this.detach()
    this.disposal = Promise.all([this.initializing, ...this.releases]).then(() => Promise.all(this.releases)).then(() => {})
    return this.disposal
  }

  private publish(update: Partial<PageState>): void {
    const state = { ...this.getSnapshot(), ...update, generation: this.getSnapshot().generation + 1 }
    this.state.set({ ...state, available: !this.lifetime.signal.aborted && this.ready && this.element !== undefined
      && state.observed && !state.loading && state.error === undefined })
  }

  private detach(): void {
    this.attachment?.life.abort()
    this.attachment = undefined
    this.dropGuest()
  }

  private dropGuest(): void {
    this.guestLife?.abort()
    this.guestLife = undefined
    this.element?.remove()
    this.element = undefined
    this.ready = false
    const lease = this.lease
    this.lease = undefined
    this.publish({ observed: false, loading: false })
    if (lease !== undefined) void this.release(lease)
  }

  private initialize(): void {
    const attachment = this.attachment
    const bridge = this.bridge
    if (attachment === undefined || bridge === undefined || this.initializing !== undefined
      || this.element !== undefined || this.pending === undefined || this.lifetime.signal.aborted) return
    const signal = AbortSignal.any([attachment.life.signal, this.lifetime.signal])
    this.initializing = this.acquire(attachment.host, bridge, signal).catch((_error: unknown) => {
      if (!signal.aborted) { this.dropGuest(); this.fail() }
    }).finally(() => {
      this.initializing = undefined
      if (this.attachment !== attachment) this.initialize()
    })
  }

  private async acquire(host: HTMLElement, bridge: BrowserBridge, signal: AbortSignal): Promise<void> {
    const workspace = await this.workspace(signal)
    if (signal.aborted) return
    const reservation = await bridge.acquire(workspace)
    if (signal.aborted) { await this.release(reservation.lease); return }
    this.lease = reservation.lease
    const guest = document.createElement('webview') as OwnedWebview
    guest.className = css.guest as string
    guest.dataset.sidebarBrowserFrame = 'webview'
    guest.setAttribute('name', reservation.lease)
    guest.setAttribute('partition', reservation.partition)
    guest.setAttribute('allowpopups', '')
    guest.setAttribute('src', `about:blank#${reservation.lease}`)
    this.element = guest
    const life = new AbortController()
    this.guestLife = life
    const guestSignal = AbortSignal.any([signal, life.signal])
    const stopOpen = bridge.onOpenRequested(reservation.lease, url => { if (!guestSignal.aborted) this.openRequested(url) })
    guestSignal.addEventListener('abort', stopOpen, { once: true })
    guest.addEventListener('dom-ready', () => { this.ready = true; this.loadPending(); this.observe(guest) }, { signal: guestSignal })
    for (const type of ['did-navigate', 'did-navigate-in-page', 'did-start-navigation', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) {
      guest.addEventListener(type, (event) => {
        if ((type === 'did-navigate-in-page' || type === 'did-start-navigation')
          && 'isMainFrame' in event && event.isMainFrame === false) return
        if (type === 'did-start-navigation' || type === 'did-start-loading') this.publish({ loading: true })
        else this.observe(guest)
      }, { signal: guestSignal })
    }
    guest.addEventListener('did-fail-load', (event) => {
      if ('isMainFrame' in event && event.isMainFrame === false) return
      if ('errorCode' in event && event.errorCode === -3) return
      this.fail()
    }, { signal: guestSignal })
    for (const type of ['render-process-gone', 'destroyed']) guest.addEventListener(type, () => { this.dropGuest(); this.fail() }, { signal: guestSignal })
    host.append(guest)
  }

  private loadPending(): void {
    const guest = this.element
    const url = this.pending
    if (!this.ready || guest === undefined || url === undefined) return
    this.pending = undefined
    const generation = this.getSnapshot().generation
    void guest.loadURL(url).catch((_error: unknown) => {
      if (this.element === guest && !this.lifetime.signal.aborted && this.getSnapshot().generation === generation) this.fail()
    })
  }

  private observe(guest: OwnedWebview): void {
    if (this.element !== guest || this.lifetime.signal.aborted) return
    try {
      const url = address(guest.getURL(), this.applicationOrigin)
      if (url === undefined) return
      this.publish({ url, title: guest.getTitle() || new URL(url).hostname, observed: true, loading: guest.isLoading(), error: undefined })
    } catch (_error) { this.fail() }
  }

  private fail(): void { this.publish({ error: 'load-failed', loading: false, observed: false }) }

  private release(lease: GuestLease): Promise<void> {
    const bridge = this.bridge
    if (bridge === undefined) return Promise.resolve()
    const released = bridge.release(lease).catch((error: unknown) => {
      console.error('Reference browser guest release failed', error)
    }).finally(() => { this.releases.delete(released) })
    this.releases.add(released)
    return released
  }
}
