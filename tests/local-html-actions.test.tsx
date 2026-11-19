/** Source-plane unit tests: primitives are mocked; Cordis owns the actual plugin lifetime. */
import { createElement } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { WorkspaceFileStat } from '@deepseek-ai/dsh-api-workspace-files/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { registerLocalHtmlActions, localHtmlActionsInject } from '../src/client/local-html-actions.ts'
import { LocalHtmlAction } from '../src/client/LocalHtmlAction.tsx'
import type { LocalHtmlActionInjected, LocalHtmlActionProps } from '../src/client/LocalHtmlAction.tsx'
import { localHtmlEn, localHtmlZh } from '../src/client/local-html-locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: ({ children, onClick }: { children: string; onClick(): void }) => createElement('button', { onClick }, children),
}))
afterEach(cleanup)

type Action = { id: string; label: string; disabled?: boolean; run?: () => void | Promise<void> }
type Contribution = { id: string; target: 'file'; resolve(target: { sessionId: SessionId; path: string }, signal: AbortSignal): Promise<readonly Action[]> }
type Toolbar = { inject(sessionId: SessionId): LocalHtmlActionInjected }
const origin = 'origin' as SessionId

async function bench() {
  const ctx = new Context()
  const menus = new Map<string, Contribution>()
  const slots = new Map<string, Toolbar>()
  const dictionaries = new Set<string>()
  const openTabIn = vi.fn()
  const createDrafts = vi.fn()
  const readBytes = vi.fn()
  const stat = vi.fn<(...args: [SessionId, string, AbortSignal]) => Promise<RemoteResult<WorkspaceFileStat>>>()
    .mockResolvedValue({ ok: true, value: { absolutePath: 'E:\\reports\\Canonical.HTML', version: 'one' } })
  ctx.provide('contextMenus', { register: (item: Contribution) => {
    menus.set(item.id, item)
    return () => { menus.delete(item.id) }
  } })
  ctx.provide('sidebarRight', { openTabIn })
  ctx.provide('slots', {
    inject: (_name: string, install: () => () => void) => install(),
    register: (options: Toolbar & { id: string }) => {
      slots.set(options.id, options)
      return () => { slots.delete(options.id) }
    },
  })
  ctx.provide('locale', {
    register: (namespace: string) => { dictionaries.add(namespace); return () => { dictionaries.delete(namespace) } },
    bind: () => (key: keyof typeof localHtmlEn) => localHtmlEn[key],
  })
  ctx.provide('remote', { workspaceFiles: { stat, readBytes } })
  ctx.provide('remote.workspaceFiles', { stat, readBytes })
  ctx.provide('conversation', { createDrafts })
  const fiber = ctx.plugin({ inject: [...localHtmlActionsInject], apply: registerLocalHtmlActions })
  await fiber.await()
  const menu = menus.get('dsh-browser-context.local-html')!
  return { ctx, fiber, menus, slots, dictionaries, menu, stat, openTabIn, readBytes, createDrafts }
}

describe('local HTML explicit opening', () => {
  it('filters extensions, resolves the captured session path, and sends only canonical plain path data', async () => {
    const b = await bench()
    try {
      const preparation = new AbortController()
      for (const path of ['report.md', 'report.html.js', 'report.htm/child']) {
        expect(await b.menu.resolve({ sessionId: origin, path }, preparation.signal)).toEqual([])
      }
      expect(b.stat).not.toHaveBeenCalled()
      const items = await b.menu.resolve({ sessionId: origin, path: 'report.HTML' }, preparation.signal)
      expect(b.stat).toHaveBeenLastCalledWith(origin, 'report.HTML', preparation.signal)
      // Dismissing the popup normally aborts its preparation before the selected action runs.
      preparation.abort()
      b.ctx.provide('sessions', { selected: 'other' })
      await items[0]!.run!()
      expect(b.openTabIn).toHaveBeenLastCalledWith(origin, 'reference-browser', {
        params: { localFile: { path: 'E:\\reports\\Canonical.HTML' } }, revealIfOpened: false,
      })
      const htm = await b.menu.resolve({ sessionId: origin, path: 'report.HtM' }, new AbortController().signal)
      expect(htm[0]?.label).toBe(localHtmlEn.open)
      expect(b.readBytes).not.toHaveBeenCalled()
      expect(b.createDrafts).not.toHaveBeenCalled()
    } finally { await b.fiber.dispose() }
  })

  it('shows a disabled explanation for stat failures and ignores cancelled preparations', async () => {
    const b = await bench()
    try {
      b.stat.mockResolvedValueOnce({ ok: false, error: { code: 'workspace-file/not-found', message: 'Gone', details: { path: 'gone.html' } } } as RemoteResult<WorkspaceFileStat>)
      const failed = await b.menu.resolve({ sessionId: origin, path: 'gone.html' }, new AbortController().signal)
      expect(failed).toEqual([{ id: 'open', label: localHtmlEn.unavailable, disabled: true }])
      b.stat.mockRejectedValueOnce(new Error('Transport unavailable'))
      expect((await b.menu.resolve({ sessionId: origin, path: 'failed.html' }, new AbortController().signal))[0]?.disabled).toBe(true)
      const aborted = new AbortController()
      aborted.abort()
      await expect(b.menu.resolve({ sessionId: origin, path: 'cancelled.html' }, aborted.signal)).rejects.toMatchObject({ name: 'AbortError' })
      const pending = new AbortController()
      b.stat.mockImplementationOnce(async () => { pending.abort(); return { ok: true, value: { absolutePath: '/report.html', version: 'two' } } })
      await expect(b.menu.resolve({ sessionId: origin, path: 'pending.html' }, pending.signal)).rejects.toMatchObject({ name: 'AbortError' })
      expect(b.openTabIn).not.toHaveBeenCalled()
    } finally { await b.fiber.dispose() }
  })

  it('opens HTML from the toolbar without sending chat content and removes every registration on disposal', async () => {
    const b = await bench()
    const face = b.slots.get('dsh-browser-context.local-html')!.inject(origin)
    const props = { absolutePath: '/report.hTmL', ...face, t: (key: keyof typeof localHtmlZh) => localHtmlZh[key] } as LocalHtmlActionProps
    const view = render(createElement(LocalHtmlAction, props))
    fireEvent.click(view.getByRole('button', { name: localHtmlZh.open }))
    expect(b.openTabIn).toHaveBeenCalledWith(origin, 'reference-browser', { params: { localFile: { path: '/report.hTmL' } }, revealIfOpened: false })
    expect(b.readBytes).not.toHaveBeenCalled()
    expect(b.createDrafts).not.toHaveBeenCalled()
    view.rerender(createElement(LocalHtmlAction, { ...props, absolutePath: '/report.txt' }))
    expect(view.queryByRole('button')).toBeNull()
    const items = await b.menu.resolve({ sessionId: origin, path: 'report.html' }, new AbortController().signal)
    await b.fiber.dispose()
    expect(b.menus.size).toBe(0)
    expect(b.slots.size).toBe(0)
    expect(b.dictionaries.size).toBe(0)
    await items[0]!.run!()
    face.openLocalHtml('/stale.html')
    expect(b.openTabIn).toHaveBeenCalledTimes(1)
  })
})
