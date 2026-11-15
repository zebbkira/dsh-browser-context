import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/client/index.ts'
import { makeReference } from '../src/client/reference.ts'
import { registerReferenceBrowser } from '../src/browser/index.ts'
vi.mock('../src/browser/index.ts', () => ({ registerReferenceBrowser: vi.fn(), referenceBrowserInject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs', 'workspaces'] }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({ Button: () => null, Menu: () => null, MenuItemButton: () => null, Tooltip: () => null }))

describe('slot lifetime and session-addressed native integration', () => {
  it('waits on the Browser declaration, registers a list id, and removes its contribution on disposal', () => {
    const disposers: (() => void)[] = []
    const removed = vi.fn()
    const registration = vi.fn(() => removed)
    const ctx = {
      configForms: { get: vi.fn(() => ({ getSnapshot: () => ({ status: 'ready', value: { maxTextBytes: 65536, maxImageBytes: 10485760 } }), subscribe: () => () => {} })) },
      locale: { register: vi.fn(() => vi.fn()) },
      slots: { inject: vi.fn((_name, install) => install()), register: registration },
      sessions: { binding: vi.fn(() => ({ sessionId: 'one' })) },
      conversation: {},
      effect: (setup: () => (() => void)) => { const dispose = setup(); disposers.push(dispose) },
    }
    apply(ctx as Context)
    expect(registerReferenceBrowser).toHaveBeenCalledWith(ctx)
    expect(ctx.configForms.get).toHaveBeenCalledWith('dsh-browser-context')
    const options = registration.mock.calls[0]![0]
    const injected = options.inject('one')
    expect(injected.hooks.config).toBe(ctx.configForms.get.mock.results[0]!.value)
    expect(injected.readLimits()).toEqual({ maxTextBytes: 65536, maxImageBytes: 10485760 })
    expect(ctx.slots.inject).toHaveBeenCalledWith('browserContext.actions', expect.any(Function))
    expect(registration.mock.calls[0]![0]).toMatchObject({ name: 'browserContext.actions', id: 'dsh-browser-context', locale: 'browserContext' })
    for (const dispose of disposers.reverse()) dispose()
    expect(removed).toHaveBeenCalledTimes(1)
  })
  it('rejects obsolete retained session generations and disposed plugin callbacks before any native mutation', () => {
    const disposers: (() => void)[] = []
    let binding = { sessionId: 'one' }
    let options: { inject(sessionId: string): { commit(...args: unknown[]): void } }
    const createDrafts = vi.fn()
    const ctx = {
      configForms: { get: vi.fn(() => ({ getSnapshot: () => ({ status: 'ready', value: { maxTextBytes: 65536, maxImageBytes: 10485760 } }), subscribe: () => () => {} })) },
      locale: { register: () => () => {} },
      slots: { inject: (_name, install) => install(), register: (value) => { options = value; return () => {} } },
      sessions: { binding: () => binding }, conversation: { createDrafts },
      effect: (setup: () => (() => void)) => { disposers.push(setup()) },
    }
    apply(ctx as Context)
    const injected = options!.inject('one')
    binding = { sessionId: 'one' }
    const reference = makeReference({ kind: 'selection', url: 'https://example.com/', title: 'Page', text: 'quote' }, 'now')
    expect(() => injected.commit(reference, {}, { start: 0, end: 0, draftRev: 0 })).toThrow('changed')
    for (const dispose of disposers.reverse()) dispose()
    expect(() => injected.commit(reference, {}, { start: 0, end: 0, draftRev: 0 })).toThrow('changed')
    expect(createDrafts).not.toHaveBeenCalled()
  })
})
