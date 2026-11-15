/** Stock CWD partition-key protocol, adapted from DSH ui-sidebar-browser (MIT, DeepSeek). */
import type { WorkspaceSource } from '@deepseek-ai/dsh-api-workspace-controller/client'

/** @param source - public Workspace membership. @param sessionId - owning Session. @param signal - guest lifetime. @returns stock-compatible partition key. */
export async function workspaceKey(source: WorkspaceSource, sessionId: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (source.getSnapshot().phase !== 'ready') {
    await new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        unsubscribe()
        reject(new DOMException('Reference browser closed', 'AbortError'))
      }
      const unsubscribe = source.subscribe(() => {
        if (source.getSnapshot().phase !== 'ready') return
        unsubscribe()
        signal.removeEventListener('abort', abort)
        resolve()
      })
      signal.addEventListener('abort', abort, { once: true })
    })
  }
  signal.throwIfAborted()
  const workspace = source.getSnapshot().items.find(item => item.sessionIds.some(id => id === sessionId))
  return workspace === undefined ? `session:${sessionId}` : `cwd:${workspace.path}`
}
