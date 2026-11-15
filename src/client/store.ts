/** Session-scoped, memory-only recovery; page content is never persisted automatically. */
import { defineStore } from '@deepseek-ai/dsh-client-store'
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { Failure, Reference } from './reference.ts'
import type { BrowserContextSource } from '../browser/contract.ts'
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
/** A manual input keeps the context and draft revision from its opening gesture. */
export interface PasteDraft { sessionId: SessionId; source: BrowserContextSource; span: TokenSpan; time: string; text: string }
const videoSubtitleNotices = {
  'not-available': 'videoAddedIdentityUnavailable',
  'not-provided': 'videoAddedSubtitleUnavailable',
  'login-required': 'videoAddedLoginRequired',
  'access-denied': 'videoAddedAccessDenied',
  'request-failed': 'videoAddedSubtitleRequestFailed',
  timeout: 'videoAddedSubtitleTimeout',
} as const
type VideoSubtitleNotice = typeof videoSubtitleNotices[keyof typeof videoSubtitleNotices]
interface State { recovery: Reference | undefined; paste: PasteDraft | undefined; notice: Failure | 'added' | 'videoAddedNoSubtitles' | VideoSubtitleNotice | undefined }
type Actions = {
  editPaste: (draft: State, paste: PasteDraft | undefined) => void
  retain: (draft: State, reference: Reference) => void
  report: (draft: State, notice: State['notice']) => void
  complete: (draft: State, reference: Reference) => void
  clear: (draft: State) => void
}
/** @returns one registration-owned handle with no disk persistence. */
export function createRecoveryStore(): EngineStoreHandle<State, Actions> {
  return defineStore({
    init: (): State => ({ recovery: undefined, paste: undefined, notice: undefined }),
    actions: {
      editPaste: (draft, paste: PasteDraft | undefined) => { draft.paste = paste },
      retain: (draft, reference: Reference) => { draft.recovery = reference },
      report: (draft, notice: State['notice']) => { draft.notice = notice },
      complete: (draft, reference: Reference) => {
        if (draft.recovery !== undefined && (draft.recovery.time !== reference.time || draft.recovery.source !== reference.source)) return
        draft.recovery = undefined
        if (reference.capture.kind === 'pasted-selection' && draft.paste?.time === reference.time
          && draft.paste.text === reference.capture.text) draft.paste = undefined
        draft.notice = reference.capture.kind === 'video' && reference.capture.subtitleStatus === 'not-loaded'
          ? reference.capture.subtitleReason === undefined ? 'videoAddedNoSubtitles' : videoSubtitleNotices[reference.capture.subtitleReason]
          : 'added'
      },
      clear: draft => { draft.recovery = undefined; draft.notice = undefined },
    },
  })
}
export type RecoveryStore = ReturnType<typeof createRecoveryStore>
