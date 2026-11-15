import { expect, it } from 'vitest'
import { errorDetails } from '../src/client/error-details.ts'
it('exposes code and native cause name/message without stacks or authenticated source URLs', () => {
  const cause = new TypeError('native capture failed https://user:pass@example.com/p?token=hidden&q=ok#access_token=fragment')
  const error = Object.assign(new Error('capture failed', { cause }), { code: 'failed' })
  const text = errorDetails(error, 1024)
  expect(text).toContain('failed | Error: capture failed\nTypeError: native capture failed')
  expect(text).toContain('https://example.com/p?q=ok')
  expect(text).not.toMatch(/hidden|fragment|user:pass|at /u)
})
it('bounds complete UTF-8 details and terminates cyclic cause chains', () => {
  const error = Object.assign(new Error('中文'.repeat(100)), { code: 'failed' })
  error.cause = error
  const text = errorDetails(error, 31)
  expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(31)
  expect(text).not.toContain('\uFFFD')
  const cycle = new Error('cycle'); cycle.cause = cycle
  expect(errorDetails(cycle, 1024)).toBe('Error: cycle')
})
