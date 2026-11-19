/** Register a self-owned reference-browser tab using unmodified stock Sidebar and Desktop APIs. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { GuideArtworkBrowser } from '@deepseek-ai/dsh-client-ui-primitives'
import { browserBridge } from './bridge.ts'
import { NativePage } from './NativePage.ts'
import type { PageState } from './NativePage.ts'
import { CaptureError } from './capture.ts'
import type { BrowserActionsOwnerProps } from './contract.ts'
import { workspaceKey } from './workspace.ts'
import { ReferenceBrowserBody, ReferenceBrowserTitle } from './View.tsx'
import { en, zh } from './locales.ts'
import type { LocalHtmlLimits, LocalHtmlRequest } from './local-html-types.ts'
import { prepareLocalHtml } from '../readers/local-html.ts'

export type { BrowserActionsOwnerProps, BrowserContextCapture, BrowserContextCaptureKind, BrowserContextCaptureLimits,
  BrowserContextCaptureError, BrowserContextCaptureErrorCode, BrowserContextSource } from './contract.ts'

/** Root plugin must declare these services before calling registerReferenceBrowser. */
export const referenceBrowserInject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'workspaces'] as const
const ID = 'dsh-browser-context.reference-browser'

/** Values supplied through the framework injection face, not through a stock Browser service. */
export interface BrowserInjected {
  readonly keyedHooks: { readonly referenceBrowserState: (key: string) => HostObservable<PageState> }
  /** @param request - committed own viewport and tab occurrence. @returns physical attachment cleanup. */
  mount(request: { tabId: TabId; signal: AbortSignal; viewportId: string; initialUrl: string | undefined; initialLocal?: LocalHtmlRequest; openRequested: (url: string) => void }): () => void
  /** @param tabId - owning tab. @param value - explicit address input. */
  load(tabId: TabId, value: string): void
  /** @param tabId - owning tab. */
  reload(tabId: TabId): void
  readonly capture: (tabId: TabId, ...request: Parameters<BrowserActionsOwnerProps['capture']>) => ReturnType<BrowserActionsOwnerProps['capture']>
  readonly pickElement: (tabId: TabId, ...request: Parameters<NonNullable<BrowserActionsOwnerProps['pickElement']>>) => ReturnType<NonNullable<BrowserActionsOwnerProps['pickElement']>>
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap { 'reference-browser': { readonly url?: string; readonly localFile?: LocalHtmlRequest } }
}

/**
 * Register an additional page; the stock Browser kind and its components remain untouched.
 * @param ctx - apply-owned context with referenceBrowserInject services; all contributions unwind with its fiber.
 */
export function registerReferenceBrowser(ctx: Context, readLocalLimits: () => LocalHtmlLimits): void {
  const bridge = browserBridge()
  const sessions = new Map<SessionId, { pages: Map<TabId, NativePage>; face: BrowserInjected }>()
  const endings = new Set<Promise<void>>()
  let disposed = false
  const end = (page: NativePage): void => {
    const completion = page.dispose().catch((error: unknown) => {
      console.error('Reference browser page disposal failed; the page remains closed', error)
    }).finally(() => { endings.delete(completion) })
    endings.add(completion)
  }
  ctx.effect(() => async () => {
    disposed = true
    for (const { pages } of sessions.values()) for (const page of pages.values()) end(page)
    sessions.clear()
    await Promise.all(endings)
  }, 'browser-context.owned-pages')
  const faceOf = (sessionId: SessionId): BrowserInjected => {
    const existing = sessions.get(sessionId)
    if (existing !== undefined) return existing.face
    const pages = new Map<TabId, NativePage>()
    const pageOf = (tabId: TabId): NativePage => {
      let page = pages.get(tabId)
      if (page === undefined) {
        page = new NativePage(bridge, signal => workspaceKey(ctx.workspaces.list, sessionId, signal), window.location.origin,
          async (request, signal) => {
            const limits = readLocalLimits()
            const bundle = await prepareLocalHtml(sessionId, request.path,
              (path, options, readSignal) => ctx.remote.workspaceFiles.readBytes(sessionId, path, options, readSignal), limits, signal)
            return { bundle, limits }
          })
        pages.set(tabId, page)
      }
      return page
    }
    const face: BrowserInjected = {
      keyedHooks: { referenceBrowserState: key => pageOf(key as TabId) },
      mount: request => disposed ? () => {} : pageOf(request.tabId).mount(request.viewportId, request.signal, request.initialUrl, request.openRequested, request.initialLocal),
      load: (tabId, value) => { if (!disposed) pages.get(tabId)?.loadUrl(value) },
      reload: tabId => { if (!disposed) pages.get(tabId)?.reload() },
      capture: (tabId, kind, limits) => {
        const page = pages.get(tabId)
        return disposed || page === undefined ? Promise.reject(new CaptureError('closed')) : page.capture(kind, limits)
      },
      pickElement: (tabId, limits, signal, instruction) => {
        const page = pages.get(tabId)
        return disposed || page === undefined ? Promise.reject(new CaptureError('closed')) : page.pickElement(limits, signal, instruction)
      },
    }
    sessions.set(sessionId, { pages, face })
    return face
  }
  const openTabs = ctx.sidebarRight.openTabs
  ctx.effect(() => openTabs.subscribe(() => {
    const open = openTabs.getSnapshot()
    for (const [sessionId, { pages }] of sessions) for (const [tabId, page] of pages) {
      if (open.some(tab => tab.sessionId === sessionId && tab.tabId === tabId)) continue
      pages.delete(tabId)
      end(page)
    }
  }), 'browser-context.page-membership')
  const t = ctx.locale.bind('referenceBrowser')
  ctx.effect(() => ctx.locale.register('referenceBrowser', { en, zh }), 'browser-context.page-copy')
  ctx.effect(() => ctx.sidebarRightTabs.register({ id: ID, kind: 'reference-browser', multiple: true,
    keepMounted: bridge !== undefined, title: () => t('title'),
    guide: [{ id: 'new', order: 35, title: () => t('title'), description: () => t('description'), icon: GuideArtworkBrowser }],
  }), 'browser-context.page-type')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab', key: ID, locale: 'referenceBrowser',
    children: { 'browserContext.actions': { kind: 'list', scope: 'session' } },
    inject: (sessionId): BrowserInjected => faceOf(sessionId),
  }, ReferenceBrowserBody)), 'browser-context.page-body')
  ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
    name: 'sidebar.right.pane.tab.title', key: ID, locale: 'referenceBrowser',
    inject: (sessionId): BrowserInjected => faceOf(sessionId),
  }, ReferenceBrowserTitle)), 'browser-context.page-title')
}
