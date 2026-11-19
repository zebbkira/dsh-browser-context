/** Read wire-backed settings without inferring schema defaults; client module creation supplies no Host Config argument. */
import type { ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { Limits } from './reference.ts'
import { ReferenceError } from './reference.ts'
import { LocalHtmlError } from '../browser/local-html-types.ts'
import type { LocalHtmlLimits } from '../browser/local-html-types.ts'
/** New local-file operations require their own wire-resolved settings, without changing web capture limits. */
export interface HostSettings extends Limits {
  readonly localHtmlMaxBytes?: number
  readonly localHtmlMaxFiles?: number
  readonly localHtmlTimeoutMs?: number
}
/** @param snapshot - authoritative Host form. @returns complete local-file settings or a visible configuration failure. */
export function resolveLocalHtmlLimits(snapshot: ConfigFormSnapshot<HostSettings>): LocalHtmlLimits {
  const value = snapshot.value
  if (snapshot.status !== 'ready' || value === undefined
    || !Number.isSafeInteger(value.localHtmlMaxBytes) || value.localHtmlMaxBytes === undefined || value.localHtmlMaxBytes <= 0
    || !Number.isSafeInteger(value.localHtmlMaxFiles) || value.localHtmlMaxFiles === undefined || value.localHtmlMaxFiles <= 0
    || !Number.isSafeInteger(value.localHtmlTimeoutMs) || value.localHtmlTimeoutMs === undefined || value.localHtmlTimeoutMs <= 0 || value.localHtmlTimeoutMs > 2147483647) {
    throw new LocalHtmlError('config')
  }
  return { maxBytes: value.localHtmlMaxBytes, maxFiles: value.localHtmlMaxFiles, timeoutMs: value.localHtmlTimeoutMs }
}
/** @param snapshot - authoritative wire-backed form state. @returns whether the size limits and any supplied subtitle timeout are usable. */
export function limitsAvailable(snapshot: ConfigFormSnapshot<Limits>): boolean {
  return snapshot.status === 'ready' && snapshot.value !== undefined
    && Number.isSafeInteger(snapshot.value.maxTextBytes) && snapshot.value.maxTextBytes > 0
    && Number.isSafeInteger(snapshot.value.maxImageBytes) && snapshot.value.maxImageBytes > 0
    && (snapshot.value.subtitleRequestTimeoutMs === undefined || (Number.isSafeInteger(snapshot.value.subtitleRequestTimeoutMs)
      && snapshot.value.subtitleRequestTimeoutMs > 0 && snapshot.value.subtitleRequestTimeoutMs <= 2147483647))
}
/** @param snapshot - form state read at the user gesture. @returns an operation-owned limit copy; no implicit defaults. */
export function resolveLimits(snapshot: ConfigFormSnapshot<Limits>): Limits {
  if (!limitsAvailable(snapshot) || snapshot.value === undefined) throw new ReferenceError('config')
  return { maxTextBytes: snapshot.value.maxTextBytes, maxImageBytes: snapshot.value.maxImageBytes,
    ...(snapshot.value.subtitleRequestTimeoutMs === undefined ? {} : { subtitleRequestTimeoutMs: snapshot.value.subtitleRequestTimeoutMs }) }
}
