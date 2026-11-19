/** Document toolbar action over the preview owner's resolved file path. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import type {} from './local-html-locales.ts'

/** Session-bound callbacks supplied by the registration closure. */
export interface LocalHtmlActionInjected {
  openLocalHtml(path: string): void
}

/** Standard toolbar owner data with plugin-local copy and callback. */
export type LocalHtmlActionProps = PropsRuntime<'sidebar.right.tab.document.actions'>
  & PropsLocale<'referenceBrowserLocalHtml'> & InjectFace<LocalHtmlActionInjected>

/** @param props - resolved preview path and session-bound opener. @returns an HTML-only action. */
export function LocalHtmlAction({ absolutePath, openLocalHtml, t }: LocalHtmlActionProps) {
  if (!/\.html?$/iu.test(absolutePath)) return null
  return <Button size="sm" variant="ghost" onClick={() => { openLocalHtml(absolutePath) }}>{t('open')}</Button>
}
