import { describe, expect, it } from 'vitest'
import { limitsAvailable, resolveLimits } from '../src/client/config.ts'
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Limits } from '../src/client/reference.ts'
const snapshot = (status: ConfigFormSnapshot<Limits>['status'], value: Limits | undefined): ConfigFormSnapshot<Limits> => ({ status, value, base: {}, user: {}, revision: 1, writable: true })
describe('authoritative Host configuration form', () => {
  it('takes wire-resolved numeric values and copies them at the gesture instead of using client module config', () => {
    const value = { maxTextBytes: 4096, maxImageBytes: 524288 }
    const limits = resolveLimits(snapshot('ready', value))
    expect(limits).toEqual(value)
    value.maxTextBytes = 1
    expect(limits.maxTextBytes).toBe(4096)
  })
  it.each(['loading', 'unavailable'] as const)('does not infer defaults from %s or a stale last value', status => {
    const state = snapshot(status, { maxTextBytes: 4096, maxImageBytes: 524288 })
    expect(limitsAvailable(state)).toBe(false)
    expect(() => resolveLimits(state)).toThrow('config')
  })
  it.each([0, -1, 1.5, Infinity, NaN, undefined, '4096'])('rejects invalid wire limit %s', value => {
    const state = snapshot('ready', { maxTextBytes: value, maxImageBytes: 1 } as Limits)
    expect(() => resolveLimits(state)).toThrow('config')
  })
  it('copies the configured subtitle request timeout without inventing one for legacy non-video settings', () => {
    const value = { maxTextBytes: 4096, maxImageBytes: 1024, subtitleRequestTimeoutMs: 17000 }
    const limits = resolveLimits(snapshot('ready', value))
    expect(limits.subtitleRequestTimeoutMs).toBe(17000)
    value.subtitleRequestTimeoutMs = 1
    expect(limits.subtitleRequestTimeoutMs).toBe(17000)
    expect(resolveLimits(snapshot('ready', { maxTextBytes: 4096, maxImageBytes: 1024 }))).not.toHaveProperty('subtitleRequestTimeoutMs')
  })
  it.each([0, -1, 1.5, Infinity, NaN, 2147483648])('rejects invalid configured subtitle timeout %s', value => {
    const state = snapshot('ready', { maxTextBytes: 4096, maxImageBytes: 1024, subtitleRequestTimeoutMs: value })
    expect(limitsAvailable(state)).toBe(false)
    expect(() => resolveLimits(state)).toThrow('config')
  })
  it('rejects a ready form without a resolved section', () => expect(() => resolveLimits(snapshot('ready', undefined))).toThrow('config'))
})
