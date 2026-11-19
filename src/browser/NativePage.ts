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
import type { ElementPickLimits, PickedElementCapture } from './annotation.ts'
import type { LocalHtmlBundle, LocalHtmlCommand, LocalHtmlLimits, LocalHtmlRequest, LocalHtmlSource, LocalHtmlErrorCode } from './local-html-types.ts'
import { LocalHtmlError } from './local-html-types.ts'
import { localHtmlBootstrapScript, localHtmlCommandScript } from './local-html-runtime.ts'
import { decodeElementPickerReply, elementPickerCancelScript, elementPickerCheckScript, elementPickerScript } from '../readers/element-picker.ts'
import css from './View.module.css'

/** Reactive state of this plugin's own guest; no stock Browser controller or DOM is consulted. */
export interface PageState {
  readonly url: string | undefined
  readonly title: string
  readonly observed: boolean
  readonly loading: boolean
  readonly available: boolean
  readonly error: 'desktop-only' | 'invalid-address' | 'load-failed' | `local-${LocalHtmlErrorCode}` | undefined
  readonly localFile?: LocalHtmlSource | undefined
  readonly localPath?: string | undefined
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

/** Loader stays in the apply closure and reads through the captured session's file authority. */
export type LocalHtmlLoader = (request: LocalHtmlRequest, signal: AbortSignal) => Promise<{ bundle: LocalHtmlBundle; limits: LocalHtmlLimits }>
interface LocalNavigation {
  readonly request: LocalHtmlRequest
  readonly controller: AbortController
  prepared?: { bundle: LocalHtmlBundle; limits: LocalHtmlLimits }
  document?: { readonly id: string; readonly physicalUrl: string; frameGeneration: number }
  task?: Promise<void>
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
  private localNavigation: LocalNavigation | undefined
  private pickerCancel: (() => void) | undefined
  private pickerDone: Promise<void> | undefined
  private readonly ended = (): void => { void this.dispose() }
  private openRequested: (url: string) => void = () => {}

  constructor(private readonly bridge: BrowserBridge | undefined,
    private readonly workspace: (signal: AbortSignal) => Promise<string>, private readonly applicationOrigin: string,
    private readonly localLoader?: LocalHtmlLoader) {}

  /** @returns stable snapshot until an owned guest event or navigation changes it. */
  getSnapshot = (): PageState => this.state.getSnapshot()
  /** @param listener - frame invalidation observer. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener)

  /** @param hostId - own viewport id. @param signal - tab occurrence. @param initialUrl - explicit open URL. @param open - popup-to-own-tab callback. @returns physical mount cleanup. */
  mount(hostId: string, signal: AbortSignal, initialUrl: string | undefined, open: (url: string) => void, initialLocal?: LocalHtmlRequest): () => void {
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
    else if (this.getSnapshot().localPath !== undefined) this.loadLocalFile(this.getSnapshot().localPath!)
    else if (this.getSnapshot().url !== undefined) this.loadUrl(this.getSnapshot().url!)
    else if (initialLocal !== undefined) this.loadLocalFile(initialLocal.path)
    else if (initialUrl !== undefined) this.loadUrl(initialUrl)
    return () => { if (this.attachment === attachment) this.detach() }
  }

  /** @param value - explicit URL input; only HTTP(S), without credentials or the application origin. */
  loadUrl(value: string): void {
    if (this.lifetime.signal.aborted) return
    const url = address(value, this.applicationOrigin)
    if (url === undefined) { this.publish({ error: 'invalid-address' }); return }
    if (this.bridge === undefined) { this.publish({ error: 'desktop-only' }); return }
    this.localNavigation?.controller.abort()
    this.localNavigation = undefined
    this.pending = url
    this.publish({ url, title: new URL(url).hostname, observed: false, loading: true, error: undefined, localFile: undefined, localPath: undefined })
    if (this.ready) this.loadPending()
    else this.initialize()
  }

  /** Reload the owned URL; same-URL requests still invalidate every pending capture. */
  reload(): void {
    const state = this.getSnapshot()
    if (state.localPath !== undefined) this.loadLocalFile(state.localPath)
    else if (state.url !== undefined) this.loadUrl(state.url)
  }

  /** Read a captured file target under its session authority, then render only inside an opaque child frame. */
  loadLocalFile(path: string): void {
    if (this.lifetime.signal.aborted) return
    this.dropGuest()
    this.pending = undefined
    this.publish({ url: undefined, localPath: path, localFile: undefined, title: path.split(/[\\/]/u).at(-1) ?? path,
      loading: true, observed: false, error: undefined })
    if (this.bridge === undefined) { this.publish({ error: 'desktop-only', loading: false }); return }
    const loader = this.localLoader
    if (loader === undefined) { this.publish({ error: 'local-unsupported', loading: false }); return }
    const navigation: LocalNavigation = { request: { path }, controller: new AbortController() }
    this.localNavigation = navigation
    const signal = AbortSignal.any([navigation.controller.signal, this.lifetime.signal,
      ...(this.occurrence === undefined ? [] : [this.occurrence])])
    let abort = (): void => {}
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new LocalHtmlError('closed'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
    })
    const reading = Promise.resolve().then(() => {
      if (signal.aborted) throw new LocalHtmlError('closed')
      return loader(navigation.request, signal)
    })
    navigation.task = Promise.race([reading, cancelled]).then(prepared => {
      if (signal.aborted || this.localNavigation !== navigation) return
      navigation.prepared = prepared
      if (this.ready) this.loadPending()
      else this.initialize()
    }).catch((error: unknown) => {
      if (!signal.aborted && this.localNavigation === navigation) this.localFail(error)
    }).finally(() => { signal.removeEventListener('abort', abort) })
  }

  private localFail(error: unknown): void {
    this.publish({ error: `local-${error instanceof LocalHtmlError ? error.code : 'frame'}`, observed: false, loading: false })
  }

  private physicalUrl(state: PageState): string | undefined {
    return state.localFile === undefined ? state.url : this.localNavigation?.document?.physicalUrl
  }

  private async executeLocal(navigation: LocalNavigation, script: string, finite = true, external?: AbortSignal): Promise<unknown> {
    const guest = this.element
    const prepared = navigation.prepared
    if (guest === undefined || prepared === undefined || this.localNavigation !== navigation) throw new LocalHtmlError('changed')
    const signal = AbortSignal.any([navigation.controller.signal, this.lifetime.signal,
      ...(this.guestLife === undefined ? [] : [this.guestLife.signal]), ...(external === undefined ? [] : [external])])
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort = (): void => {}
    const interrupted = new Promise<never>((_resolve, reject) => {
      abort = () => reject(new LocalHtmlError('closed'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      if (finite) timer = setTimeout(() => reject(new LocalHtmlError('timeout')), prepared.limits.timeoutMs)
    })
    try { return await Promise.race([guest.executeJavaScript(script), interrupted]) }
    finally { if (timer !== undefined) clearTimeout(timer); signal.removeEventListener('abort', abort) }
  }

  private async localCommand(navigation: LocalNavigation, command: LocalHtmlCommand, signal?: AbortSignal): Promise<unknown> {
    const document = navigation.document
    if (document === undefined) throw new LocalHtmlError('changed')
    return this.executeLocal(navigation, localHtmlCommandScript(document.id, command), command.kind !== 'pick', signal)
  }

  private localStatus(value: unknown, navigation: LocalNavigation): number {
    if (typeof value !== 'object' || value === null || !('documentId' in value) || value.documentId !== navigation.document?.id
      || !('ready' in value) || value.ready !== true || !('frameGeneration' in value)
      || typeof value.frameGeneration !== 'number' || !Number.isSafeInteger(value.frameGeneration) || value.frameGeneration < 1) {
      if (typeof value === 'object' && value !== null && 'code' in value && value.code === 'too-large') throw new LocalHtmlError('limit')
      if (typeof value === 'object' && value !== null && 'code' in value && value.code === 'timeout') throw new LocalHtmlError('timeout')
      throw new LocalHtmlError('frame')
    }
    return value.frameGeneration
  }

  private async assertLocalReady(navigation: LocalNavigation): Promise<void> {
    try {
      const generation = this.localStatus(await this.localCommand(navigation, { kind: 'status' }), navigation)
      if (generation !== navigation.document?.frameGeneration || this.localNavigation !== navigation) throw new LocalHtmlError('changed')
    } catch (error) {
      if (this.localNavigation === navigation && !navigation.controller.signal.aborted) {
        navigation.controller.abort()
        this.localFail(error instanceof LocalHtmlError ? error : new LocalHtmlError('changed'))
      }
      throw new CaptureError('changed')
    }
  }

  private bootstrapLocal(navigation: LocalNavigation, guest: OwnedWebview): void {
    const prepared = navigation.prepared
    if (prepared === undefined || this.lease === undefined || navigation.document !== undefined) return
    const physicalUrl = `about:blank#${this.lease}`
    navigation.document = { id: crypto.randomUUID(), physicalUrl, frameGeneration: 0 }
    const document = navigation.document
    navigation.task = (async () => {
      if (guest.getURL() !== physicalUrl) throw new LocalHtmlError('changed')
      const result = await this.executeLocal(navigation, localHtmlBootstrapScript(prepared.bundle, document.id, physicalUrl, prepared.limits))
      if (this.localNavigation !== navigation || navigation.controller.signal.aborted || this.element !== guest) return
      document.frameGeneration = this.localStatus(result, navigation)
      this.publish({ url: prepared.bundle.source.resourceAddress, localFile: prepared.bundle.source,
        localPath: prepared.bundle.source.path, title: prepared.bundle.title, observed: true, loading: false, error: undefined })
    })().catch((error: unknown) => {
      if (!navigation.controller.signal.aborted && this.localNavigation === navigation) this.localFail(error)
    })
  }

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
      if (url !== this.physicalUrl(state)) throw new CaptureError('changed')
    }
    try {
      assertCurrent()
      const local = this.localNavigation
      if (state.localFile !== undefined && local !== undefined) { await this.assertLocalReady(local); assertCurrent() }
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
          const reply = local !== undefined && state.localFile !== undefined
            ? await this.localCommand(local, { kind: 'selection', maxBytes: limits.maxBytes })
            : await element.executeJavaScript(selectionScript(limits.maxBytes))
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
        const reply = local !== undefined && state.localFile !== undefined
          ? await this.localCommand(local, { kind: 'article', maxBytes: limits.maxBytes })
          : await element.executeJavaScript(articleScript(limits.maxBytes))
        assertCurrent()
        if (typeof reply !== 'object' || reply === null) throw new CaptureError('failed')
        if ('code' in reply && (reply.code === 'no-article' || reply.code === 'too-large')) throw new CaptureError(reply.code)
        if (!('kind' in reply) || reply.kind !== 'article' || !('format' in reply) || reply.format !== 'markdown'
          || state.localFile === undefined && (!('url' in reply) || reply.url !== state.url) || !('title' in reply) || typeof reply.title !== 'string'
          || !('text' in reply) || typeof reply.text !== 'string') throw new CaptureError('failed')
        if (reply.text.trim().length === 0) throw new CaptureError('no-article')
        result = { kind, url: state.url, title: reply.title, text: reply.text, format: 'markdown' }
      } else {
        const image = await element.capturePage()
        assertCurrent()
        result = { kind, url: state.url, title: state.title, mimeType: 'image/png', bytes: pngBytes(image.toDataURL(), limits.maxBytes) }
      }
      if (state.localFile !== undefined && local !== undefined) { await this.assertLocalReady(local); assertCurrent() }
      return boundCapture(state.localFile === undefined ? result : { ...result, localFile: state.localFile }, limits)
    } catch (error) {
      assertCurrent()
      if (error instanceof CaptureError) throw error
      throw new CaptureError('failed')
    }
  }

  /**
   * Pick one element with input interception; earlier page-owned window capture handlers can still run.
   * Cancellation removes owned overlays and listeners; unreachable documents do not block disposal.
   * @param limits - complete reply JSON and native image budgets, without truncation.
   * @param signal - caller cancellation; rejects with cancelled and discards partial output.
   * @param instruction - localized, plain-text picker instruction.
   * @returns native viewport image and hints from the same node, document and viewport.
   * @throws CaptureError on cancellation, concurrent use, navigation, closure or invalid guest output; errors contain no page data.
   */
  public async pickElement(limits: ElementPickLimits, signal: AbortSignal, instruction: string): Promise<PickedElementCapture> {
    validateLimits({ maxBytes: limits.maxTextBytes })
    validateLimits({ maxBytes: limits.maxImageBytes })
    if (this.lifetime.signal.aborted) throw new CaptureError('closed')
    if (signal.aborted) throw new CaptureError('cancelled')
    if (this.bridge === undefined) throw new CaptureError('unsupported')
    if (this.pickerCancel !== undefined) throw new CaptureError('unavailable')
    const guest = this.element, initial = this.getSnapshot()
    if (guest === undefined || !initial.available || initial.url === undefined) throw new CaptureError('unavailable')
    const nonce = crypto.randomUUID()
    const local = initial.localFile === undefined ? undefined : this.localNavigation
    const assertCurrent = (): void => {
      if (this.lifetime.signal.aborted || this.occurrence?.aborted) throw new CaptureError('closed')
      if (signal.aborted) throw new CaptureError('cancelled')
      if (this.element !== guest || this.getSnapshot().generation !== initial.generation) throw new CaptureError('changed')
      let url: string
      try { url = guest.getURL() } catch (_error) { throw new CaptureError('changed') }
      if (url !== this.physicalUrl(initial)) throw new CaptureError('changed')
    }
    const clean = async (): Promise<void> => {
      const current = this.element
      await Promise.all([...new Set([guest, current])].map(async target => {
        if (target === undefined) return
        try { await target.executeJavaScript(local?.document === undefined
          ? elementPickerCancelScript(nonce) : localHtmlCommandScript(local.document.id, { kind: 'cancel', nonce })) }
        catch (_error) { /* Navigation or destruction can make the old document unreachable. */ }
      }))
    }
    let releaseUnreachable: () => void = () => {}
    const unreachable = new Promise<void>(resolve => { releaseUnreachable = resolve })
    let rejectCancellation: (reason: CaptureError) => void = () => {}
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject })
    let cleaning: Promise<void> | undefined
    const cancel = (): void => {
      let gone = this.lifetime.signal.aborted || this.element !== guest || this.getSnapshot().generation !== initial.generation
      if (!gone) {
        try { gone = guest.getURL() !== this.physicalUrl(initial) } catch (_error) { gone = true }
      }
      if (gone) releaseUnreachable()
      let reason = new CaptureError('changed')
      try { assertCurrent() } catch (error) { if (error instanceof CaptureError) reason = error }
      cleaning ??= clean()
      rejectCancellation(reason)
    }
    let finishDone: () => void = () => {}
    this.pickerDone = new Promise(resolve => { finishDone = resolve })
    this.pickerCancel = cancel
    const unsubscribe = this.subscribe(cancel)
    signal.addEventListener('abort', cancel, { once: true })
    this.lifetime.signal.addEventListener('abort', cancel, { once: true })
    const wait = <T,>(promise: Promise<T>): Promise<T> => Promise.race([promise, cancelled])
    try {
      assertCurrent()
      if (local !== undefined) { await this.assertLocalReady(local); assertCurrent() }
      guest.focus()
      const picked = decodeElementPickerReply(await wait(local === undefined
        ? guest.executeJavaScript(elementPickerScript(instruction, limits.maxTextBytes, nonce))
        : this.localCommand(local, { kind: 'pick', instruction, maxBytes: limits.maxTextBytes, nonce }, signal)), limits.maxTextBytes)
      assertCurrent()
      const verify = async (): Promise<void> => {
        const measured = decodeElementPickerReply(await wait(local === undefined
          ? guest.executeJavaScript(elementPickerCheckScript(nonce))
          : this.localCommand(local, { kind: 'check', nonce }, signal)), limits.maxTextBytes)
        if (local !== undefined) { await this.assertLocalReady(local); assertCurrent() }
        assertCurrent()
        if (JSON.stringify(measured) !== JSON.stringify(picked)) throw new CaptureError('changed')
      }
      await verify()
      const native = await wait(guest.capturePage())
      assertCurrent()
      await verify()
      const image: Extract<BrowserContextCapture, { kind: 'viewport' }> = { kind: 'viewport', url: initial.url, title: initial.title,
        mimeType: 'image/png', bytes: pngBytes(native.toDataURL(), limits.maxImageBytes),
        ...(initial.localFile === undefined ? {} : { localFile: initial.localFile }) }
      boundCapture(image, { maxBytes: limits.maxImageBytes })
      return { image, element: picked }
    } catch (error) {
      assertCurrent()
      if (error instanceof CaptureError) throw error
      throw new CaptureError('failed')
    } finally {
      try {
        await Promise.race([cleaning ?? clean(), unreachable])
        assertCurrent()
      } finally {
        unsubscribe()
        signal.removeEventListener('abort', cancel)
        this.lifetime.signal.removeEventListener('abort', cancel)
        this.pickerCancel = undefined
        this.pickerDone = undefined
        finishDone()
      }
    }
  }

  /** @returns after acquisition and all owned guest releases settle; repeated callers join the same disposal. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    const localTask = this.localNavigation?.task
    this.lifetime.abort()
    this.occurrence?.removeEventListener('abort', this.ended)
    this.detach()
    this.disposal = Promise.all([this.initializing, this.pickerDone, localTask, ...this.releases]).then(() => Promise.all(this.releases)).then(() => {})
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
    this.localNavigation?.controller.abort()
    this.localNavigation = undefined
    this.pickerCancel?.()
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
      || this.element !== undefined || this.pending === undefined && this.localNavigation?.prepared === undefined || this.lifetime.signal.aborted) return
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
          && 'isMainFrame' in event && event.isMainFrame === false) {
          const local = this.localNavigation
          if (type === 'did-start-navigation' && local?.document !== undefined && local.document.frameGeneration > 0
            && (!('isInPlace' in event) || event.isInPlace !== true)) {
            local.controller.abort()
            this.localFail(new LocalHtmlError('changed'))
          }
          return
        }
        if (this.localNavigation !== undefined && (type === 'did-start-loading' || type === 'did-start-navigation')) return
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
    if (!this.ready || guest === undefined) return
    if (this.localNavigation?.prepared !== undefined) { this.bootstrapLocal(this.localNavigation, guest); return }
    if (url === undefined) return
    this.pending = undefined
    const generation = this.getSnapshot().generation
    void guest.loadURL(url).catch((_error: unknown) => {
      if (this.element === guest && !this.lifetime.signal.aborted && this.getSnapshot().generation === generation) this.fail()
    })
  }

  private observe(guest: OwnedWebview): void {
    if (this.element !== guest || this.lifetime.signal.aborted) return
    try {
      const physical = guest.getURL()
      const local = this.localNavigation
      if (local !== undefined && (physical === local.document?.physicalUrl || physical === `about:blank#${this.lease}`)) return
      const url = address(physical, this.applicationOrigin)
      if (url === undefined) return
      if (local !== undefined) { local.controller.abort(); this.localNavigation = undefined }
      this.publish({ url, title: guest.getTitle() || new URL(url).hostname, observed: true, loading: guest.isLoading(), error: undefined,
        localFile: undefined, localPath: undefined })
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
