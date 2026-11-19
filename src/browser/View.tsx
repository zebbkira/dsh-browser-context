/** Own page chrome and actions slot; all state arrives through framework-bound hooks and callbacks. */
import { useCallback, useId, useLayoutEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { IconLinkOutlineRegular, IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserInjected } from './index.ts'
import type { PageState } from './NativePage.ts'
import type { BrowserActionsOwnerProps } from './contract.ts'
import { CaptureError } from './capture.ts'
import css from './View.module.css'

const EMPTY_STATE: PageState = { url: undefined, title: '', observed: false, loading: false,
  available: false, error: undefined, generation: 0 }

/** Framework-derived body props; no stock Browser component types. */
export type ReferenceBrowserBodyProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsRenderSlots<'browserContext.actions'>
  & PropsLocale<'referenceBrowser'> & InjectFace<BrowserInjected>

/** @param props - own native page state and finite actions. @returns independent reference browser. */
export function ReferenceBrowserBody(props: ReferenceBrowserBodyProps): ReactNode {
  const { useTabInfo, useReferenceBrowserState, mount, load, reload, capture, pickElement, renderSlot, t } = props
  const { tab } = useTabInfo()
  const viewportId = useId()
  const state = useReferenceBrowserState(tab.id) ?? EMPTY_STATE
  const [edit, setEdit] = useState<{ url: string | undefined; text: string }>()
  const draft = edit !== undefined && edit.url === state.url ? edit.text : state.localPath ?? state.url ?? ''
  const params = tab.navigation.params
  const initialUrl = params !== undefined && 'url' in params && typeof params.url === 'string' ? params.url : undefined
  const initialLocalPath = params !== undefined && 'localFile' in params && params.localFile !== undefined ? params.localFile.path : undefined
  const local = state.localPath !== undefined || state.url === undefined && initialLocalPath !== undefined
  // Native attachment needs this component's committed viewport, not a query into any stock Browser DOM.
  useLayoutEffect(() => mount({ tabId: tab.id, signal: tab.signal, viewportId, initialUrl,
    ...(initialLocalPath === undefined ? {} : { initialLocal: { path: initialLocalPath } }),
    openRequested: url => { tab.actions.openTab('reference-browser', { params: { url }, revealIfOpened: false }) },
  }), [mount, tab.id, tab.signal, tab.actions, viewportId, initialUrl, initialLocalPath])
  const captureTab = useCallback<BrowserActionsOwnerProps['capture']>((kind, limits) => {
    if (tab.signal.aborted) return Promise.reject(new CaptureError('closed'))
    return capture(tab.id, kind, limits)
  }, [capture, tab.id, tab.signal])
  const pickTab = useCallback<NonNullable<BrowserActionsOwnerProps['pickElement']>>((limits, signal, instruction) => {
    if (tab.signal.aborted) return Promise.reject(new CaptureError('closed'))
    return pickElement(tab.id, limits, AbortSignal.any([signal, tab.signal]), instruction)
  }, [pickElement, tab.id, tab.signal])
  const submit = (event: FormEvent): void => { event.preventDefault(); if (!local) load(tab.id, draft) }
  return <div className={css.root}>
    <form className={css.toolbar} onSubmit={submit}>
      <input className={css.address} value={draft} readOnly={local} aria-label={t(local ? 'localAddress' : 'address')} placeholder={t('address')} spellCheck={false}
        onChange={event => { setEdit({ url: state.url, text: event.currentTarget.value }) }} />
      <button className={css.tool} type="submit" disabled={local} aria-label={t('go')} title={t('go')}><IconLinkOutlineRegular /></button>
      <button className={css.tool} type="button" aria-label={t('reload')} title={t('reload')}
        disabled={state.url === undefined && !local || state.error === 'desktop-only'} onClick={() => { reload(tab.id) }}><IconRefreshOutlineRegular /></button>
      {renderSlot('browserContext.actions', { available: state.available, capture: captureTab, pickElement: pickTab,
        source: state.available && state.url !== undefined
          ? { tabId: tab.id, url: state.url, title: state.title, generation: state.generation,
              ...(state.localFile === undefined ? {} : { localFile: state.localFile }) } : undefined })}
    </form>
    {state.error !== undefined && <p className={css.notice} role="status">{t(`error.${state.error}`)}</p>}
    <div className={css.content} aria-busy={state.loading}>
      <div id={viewportId} className={css.viewport} aria-label={t('title')} />
      {state.error === undefined && (state.url === undefined || state.loading)
        && <div className={css.placeholder}>{t(state.loading ? 'loading' : 'start')}</div>}
    </div>
  </div>
}

/** Framework-derived title props. */
export type ReferenceBrowserTitleProps = PropsRuntime<'sidebar.right.pane.tab.title'>
  & PropsLocale<'referenceBrowser'> & InjectFace<BrowserInjected>

/** @param props - own page snapshot. @returns observed title without consulting stock Browser state. */
export function ReferenceBrowserTitle({ useTabInfo, useReferenceBrowserState, t }: ReferenceBrowserTitleProps): ReactNode {
  const { tab } = useTabInfo()
  return useReferenceBrowserState(tab.id)?.title || t('title')
}
