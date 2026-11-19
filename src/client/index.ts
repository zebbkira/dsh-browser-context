/** Explicit Browser references; no background collection or automatic submission. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { InputActions, TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { BrowserActions } from './Actions.tsx'
import { createRecoveryStore } from './store.ts'
import { admit, ReferenceError } from './reference.ts'
import type { Limits, Reference } from './reference.ts'
import { en, zh } from './locales.ts'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import { resolveLimits, resolveLocalHtmlLimits } from './config.ts'
import type { HostSettings } from './config.ts'
import { localHtmlActionsInject, registerLocalHtmlActions } from './local-html-actions.ts'
import { registerReferenceBrowser, referenceBrowserInject } from '../browser/index.ts'

export const inject = [...new Set([...referenceBrowserInject, ...localHtmlActionsInject, 'conversation', 'sessions', 'configForms'])]
/** Injection carries only plain configuration and scoped callbacks. */
export interface Injected {
  readonly hooks: { readonly config: ConfigForm<HostSettings> }
  readLimits(): Limits
  commit(reference: Reference, actions: InputActions, span: TokenSpan, limits: Limits): void
}

/** @param ctx - plugin lifetime owner; limits come from its authoritative Host settings form. */
export function apply(ctx: Context): void {
  const form = ctx.configForms.get<HostSettings>('dsh-browser-context')
  registerReferenceBrowser(ctx, () => resolveLocalHtmlLimits(form.getSnapshot()))
  registerLocalHtmlActions(ctx)
  const store = createRecoveryStore()
  let disposed = false
  ctx.effect(() => () => { disposed = true }, 'browser-context.lifetime')
  ctx.effect(() => ctx.locale.register('browserContext', { zh, en }), 'browser-context.copy')
  ctx.effect(() => ctx.slots.inject('browserContext.actions', () => ctx.slots.register({
    name: 'browserContext.actions', id: 'dsh-browser-context', locale: 'browserContext', store,
    inject: (sessionId): Injected => {
      const binding = ctx.sessions.binding(sessionId)
      return {
        hooks: { config: form },
        readLimits: () => resolveLimits(form.getSnapshot()),
        commit: (reference, actions, span, limits) => {
          if (disposed || binding === undefined || ctx.sessions.binding(sessionId) !== binding) throw new ReferenceError('changed')
          admit(reference, sessionId, actions, span, ctx.conversation, limits)
        },
      }
    },
  }, BrowserActions)), 'browser-context.actions')
}
