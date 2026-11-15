/** Host companion: configuration validation only; no network or collection. */
import z from '@deepseek-ai/schemastery'
import { validateConfig } from './config.mjs'
/** Required limits are supplied by the bundle patch or its user override. */
export const Config = z.object({
  maxTextBytes: z.natural().min(1).required().volatile(),
  maxImageBytes: z.natural().min(1).required().volatile(),
  subtitleRequestTimeoutMs: z.natural().min(1).max(2147483647).default(15000).volatile(),
})
export const name = 'dsh-browser-context'
export const inject = []
/** Validate explicit deployment configuration without creating background work. */
export function apply(_ctx, config) {
  validateConfig({ maxTextBytes: config.maxTextBytes.get(), maxImageBytes: config.maxImageBytes.get(), subtitleRequestTimeoutMs: config.subtitleRequestTimeoutMs.get() })
}
