/** Explicit Browser capture and ordinary user-entered references share draft admission. */
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Menu, MenuItemButton, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserContextCaptureKind, BrowserContextCaptureLimits } from '../browser/contract.ts'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { Limits, Reference } from './reference.ts'
import { limitsAvailable } from './config.ts'
import { errorDetails } from './error-details.ts'
import { insertionSpan, captureFailure, imagePreview, makeReference, ReferenceError } from './reference.ts'
import type { RecoveryStore } from './store.ts'
import type { Injected } from './index.ts'
import css from './Actions.module.css'
import { isWecomDocument } from '../readers/wecom.ts'
import { isBilibiliVideo } from '../readers/bilibili.ts'

export type Props = PropsRuntime<'browserContext.actions'> & PropsLocale<'browserContext'>
  & PropsStore<RecoveryStore> & InjectFace<Injected>

/** @param props - session-bound action seat and capture capability. @returns a compact host menu and retained recovery. */
export function BrowserActions(props: Props) {
  const { available, capture, source, sessionId, inputActions, useStore, actions, t, useConfig, readLimits, commit } = props
  const configReady = limitsAvailable(useConfig(state => state))
  const { recovery, notice, paste: retainedPaste } = useStore(state => state)
  const paste = retainedPaste?.sessionId === sessionId ? retainedPaste : undefined
  const pasteChanged = paste !== undefined && (source === undefined || source.tabId !== paste.source.tabId || source.generation !== paste.source.generation
    || source.url !== paste.source.url || source.title !== paste.source.title)
  const [open, setOpen] = useState(false)
  const [failureDetails, setFailureDetails] = useState<{ sessionId: Props['sessionId']; text: string }>()
  const [pendingView, setPendingView] = useState<{ sessionId: Props['sessionId']; controller: AbortController }>()
  const busy = pendingView?.sessionId === sessionId && !pendingView.controller.signal.aborted
  const operation = useRef<AbortController | undefined>(undefined)
  const live = useRef(props)
  live.current = props
  useEffect(() => () => { operation.current?.abort() }, [sessionId, inputActions])
  const preview = useMemo(() => recovery?.capture.kind === 'viewport' ? imagePreview(recovery.capture.bytes) : undefined, [recovery])

  const add = (reference: Reference, span = insertionSpan(inputActions), operationLimits?: Limits) => {
    setFailureDetails(undefined)
    let limits = operationLimits
    try {
      limits ??= readLimits()
      commit(reference, inputActions, span, limits)
      actions.complete(reference)
      if (reference.capture.kind === 'video' && reference.capture.subtitleStatus === 'not-loaded') setOpen(true)
      return true
    } catch (error) {
      actions.retain(reference)
      actions.report(error instanceof ReferenceError ? error.code : 'unknown')
      if (limits !== undefined) setFailureDetails({ sessionId, text: errorDetails(error, limits.maxTextBytes) })
      setOpen(true)
      return false
    }
  }
  const openPaste = () => {
    if (source === undefined) { actions.report('unavailable'); setOpen(true); return }
    // Reopening never overwrites user input or silently changes its page context.
    if (paste === undefined) actions.editPaste({ sessionId, source: { ...source }, span: insertionSpan(inputActions), time: new Date().toISOString(), text: '' })
    setOpen(true)
  }
  const addPaste = () => {
    if (paste === undefined || pasteChanged || paste.text.trim() === '') return
    const reference = makeReference({ kind: 'pasted-selection', contextUrl: paste.source.url,
      contextTitle: paste.source.title, sourceVerified: false, text: paste.text }, paste.time)
    if (add(reference, paste.span)) actions.editPaste(undefined)
  }
  const begin = async (requested: BrowserContextCaptureKind) => {
    const kind = requested === 'article' && source !== undefined
      ? isWecomDocument(source.url) ? 'document' : isBilibiliVideo(source.url) ? 'video' : requested
      : requested
    setOpen(false)
    setFailureDetails(undefined)
    if (operation.current !== undefined && !operation.current.signal.aborted) return
    const pending = new AbortController()
    operation.current = pending
    setPendingView({ sessionId, controller: pending })
    const span = insertionSpan(inputActions)
    const time = new Date().toISOString()
    let limits: Limits | undefined
    try {
      limits = readLimits()
      let captureLimits: BrowserContextCaptureLimits = { maxBytes: kind === 'viewport' ? limits.maxImageBytes : limits.maxTextBytes }
      if (kind === 'video') {
        const subtitleRequestTimeoutMs = limits.subtitleRequestTimeoutMs
        if (subtitleRequestTimeoutMs === undefined || !Number.isSafeInteger(subtitleRequestTimeoutMs)
          || subtitleRequestTimeoutMs <= 0 || subtitleRequestTimeoutMs > 2147483647) {
          const cause = new Error(JSON.stringify({ field: 'subtitleRequestTimeoutMs', reason: subtitleRequestTimeoutMs === undefined ? 'missing' : 'invalid' }))
          cause.name = 'BrowserContextConfigDiagnostic'
          throw new ReferenceError('subtitleConfig', { cause })
        }
        captureLimits = { ...captureLimits, subtitleRequestTimeoutMs }
      }
      const captured = await capture(kind, captureLimits)
      if (captured.kind === 'article' && isWecomDocument(captured.url)) throw new ReferenceError('articleUnavailable')
      if (captured.kind === 'article' && (kind === 'video' || isBilibiliVideo(captured.url))) throw new ReferenceError('videoEmpty')
      const reference = makeReference(captured, time)
      // A detached callback may retain data, but never mutate any session's draft.
      if (pending.signal.aborted || live.current.sessionId !== sessionId || live.current.inputActions !== inputActions) return
      if (add(reference, span, limits) && captured.kind === 'video' && captured.subtitleStatus === 'not-loaded'
        && captured.subtitleDiagnostic !== undefined) {
        const diagnostic = captured.subtitleDiagnostic
        setFailureDetails({ sessionId, text: JSON.stringify({ name: 'BilibiliSubtitleDiagnostic', stage: diagnostic.stage,
          failure: diagnostic.failure, httpStatus: diagnostic.httpStatus, apiCode: diagnostic.apiCode }, null, 2) })
      }
    } catch (error) {
      if (!pending.signal.aborted && live.current.sessionId === sessionId && live.current.inputActions === inputActions) {
        const failure = error instanceof ReferenceError ? error.code : captureFailure(error)
        const wecomEmpty = kind === 'selection' && failure === 'empty' && source !== undefined && isWecomDocument(source.url)
        actions.report(wecomEmpty ? 'wecomEmpty' : failure)
        if (kind === 'selection' && failure === 'empty' && !wecomEmpty) openPaste()
        if (limits !== undefined) setFailureDetails({ sessionId, text: errorDetails(error, limits.maxTextBytes) })
        setOpen(true)
      }
    } finally {
      if (operation.current === pending) operation.current = undefined
      if (!pending.signal.aborted) setPendingView(undefined)
    }
  }

  return <div className={css.root}>
    <Menu open={open} onClose={() => setOpen(false)} portal align="end" compact
      anchor={<Tooltip label={t(configReady ? 'unavailable' : 'config')} disabled={available && configReady} portal side="bottom">
        <span tabIndex={!available || !configReady ? 0 : undefined} aria-label={!available || !configReady ? t(configReady ? 'unavailable' : 'config') : undefined}>
          <Button size="sm" variant="ghost" disabled={!available || !configReady || busy}
            aria-expanded={open} aria-haspopup="menu" aria-busy={busy} onClick={() => setOpen(value => !value)}>{t('quote')}</Button>
        </span>
      </Tooltip>}>
      <MenuItemButton disabled={!available || !configReady || busy} onSelect={() => { void begin('selection') }}>{t(source !== undefined && isWecomDocument(source.url) ? 'wecomSelection' : 'selection')}</MenuItemButton>
      <MenuItemButton disabled={!available || !configReady || busy} onSelect={() => { void begin('article') }}>{t(source !== undefined && isWecomDocument(source.url) ? 'document' : source !== undefined && isBilibiliVideo(source.url) ? 'video' : 'article')}</MenuItemButton>
      <MenuItemButton disabled={!available || !configReady || busy} onSelect={openPaste}>{t('paste')}</MenuItemButton>
      <MenuItemButton disabled={!available || !configReady || busy} onSelect={() => { void begin('viewport') }}>{t('viewport')}</MenuItemButton>
    {paste !== undefined && <div className={css.recovery}>
      <span className={css.notice}>{t('pasteHelp')}</span>
      <textarea className={css.source} aria-label={t('pasteInput')} value={paste.text}
        onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation() }}
        onChange={event => actions.editPaste({ ...paste, text: event.target.value })} />
      {pasteChanged && <span role="status" className={css.notice}>{t('pasteChanged')}</span>}
      <div className={css.buttons}>
        <Button size="sm" variant="ghost" disabled={busy || pasteChanged || paste.text.trim() === ''} onClick={addPaste}>{t('pasteAdd')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => actions.editPaste(undefined)}>{t('pasteDiscard')}</Button>
      </div>
    </div>}
    {notice !== undefined && <span role="status" className={css.notice}>{t(notice)}</span>}
    {failureDetails?.sessionId === sessionId && <details className={css.recovery}>
      <summary>{t('details')}</summary>
      <textarea className={css.source} readOnly aria-label={t('detailsCopy')} value={failureDetails.text} />
    </details>}
    {recovery !== undefined && <div className={css.recovery}>
      {preview !== undefined && <img className={css.preview} src={preview} alt={t('preview')} />}
      <textarea className={css.source} readOnly aria-label={t('source')} value={recovery.source} />
      <div className={css.buttons}>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => add(recovery)}>{t('retry')}</Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => actions.clear()}>{t('discard')}</Button>
      </div>
    </div>}
    </Menu>
  </div>
}
