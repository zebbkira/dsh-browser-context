/** Explicit HTML actions using the published Desktop 0.2.2-rc.1 menu and session-navigation services. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PaneId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { LocalHtmlAction } from './LocalHtmlAction.tsx'
import type { LocalHtmlActionInjected } from './LocalHtmlAction.tsx'
import { localHtmlEn, localHtmlNamespace, localHtmlZh } from './local-html-locales.ts'

/** Services required by these registrations; callers merge this list with their existing injections. */
export const localHtmlActionsInject = ['contextMenus', 'sidebarRight', 'slots', 'locale', 'remote', 'remote.workspaceFiles'] as const

interface FileTarget {
  readonly sessionId: SessionId
  readonly path: string
  readonly line?: number
  readonly paneId?: PaneId
}
interface FileAction {
  readonly id: string
  readonly label: string
  readonly disabled?: boolean
  readonly failureLabel?: string
  readonly run?: () => void | Promise<void>
}
// The local SDK predates these public services; keep their consumed methods private to this adapter.
interface PublishedContextMenus {
  register(contribution: {
    readonly id: string
    readonly target: 'file'
    readonly order: number
    resolve(target: FileTarget, signal: AbortSignal): readonly FileAction[] | Promise<readonly FileAction[]>
  }): () => void
}
interface PublishedSidebarRight {
  openTabIn(sessionId: SessionId, kind: 'reference-browser', options: {
    readonly params: { readonly localFile: { readonly path: string } }
    readonly revealIfOpened: false
  }): void
}

/** @param ctx - plugin context with localHtmlActionsInject services. All contributions leave with its fiber. */
export function registerLocalHtmlActions(ctx: Context): void {
  const published: {
    get(name: 'contextMenus'): PublishedContextMenus
    get(name: 'sidebarRight'): PublishedSidebarRight
  } = ctx
  const menus = published.get('contextMenus')
  const sidebar = published.get('sidebarRight')
  let active = true
  ctx.effect(() => () => { active = false }, 'browser-context.local-html-lifetime')
  ctx.effect(() => ctx.locale.register(localHtmlNamespace, { en: localHtmlEn, zh: localHtmlZh }), 'browser-context.local-html-copy')
  const t = ctx.locale.bind(localHtmlNamespace)
  const open = (sessionId: SessionId, path: string): void => {
    if (!active) return
    sidebar.openTabIn(sessionId, 'reference-browser', { params: { localFile: { path } }, revealIfOpened: false })
  }
  ctx.effect(() => menus.register({
    id: 'dsh-browser-context.local-html', target: 'file', order: 150,
    resolve: async ({ sessionId, path }, signal) => {
      if (!/\.html?$/iu.test(path)) return []
      signal.throwIfAborted()
      let absolutePath: string | undefined
      try {
        const result = await ctx.remote.workspaceFiles.stat(sessionId, path, signal)
        if (result.ok) absolutePath = result.value.absolutePath
      } catch (_error) {
        // A transport failure leaves a disabled action; dismissed preparations remain cancelled.
        signal.throwIfAborted()
      }
      signal.throwIfAborted()
      if (!active) return []
      if (absolutePath === undefined) return [{ id: 'open', label: t('unavailable'), disabled: true }]
      const resolvedPath = absolutePath
      return [{ id: 'open', label: t('open'), failureLabel: t('failed'), run: () => {
        // The menu cancels preparation when dismissed; execution owns no preparation signal.
        open(sessionId, resolvedPath)
      } }]
    },
  }), 'browser-context.local-html-menu')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document.actions', () => ctx.slots.register({
    name: 'sidebar.right.tab.document.actions', id: 'dsh-browser-context.local-html', locale: localHtmlNamespace,
    inject: (sessionId): LocalHtmlActionInjected => ({ openLocalHtml: path => { open(sessionId, path) } }),
  }, LocalHtmlAction)), 'browser-context.local-html-toolbar')
}
