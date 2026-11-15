/** Bounded, user-visible failure diagnostics; never submitted, logged, or persisted. */
import { sourceUrl } from './reference.ts'
function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s<>"']+/giu, url => {
    try { return sourceUrl(url) } catch (error) { return '[invalid URL]' }
  })
}
/** @param error - the current explicit operation failure. @param maxBytes - that operation's validated text budget. @returns code and cause name/message only, without stacks or URL credentials. */
export function errorDetails(error: unknown, maxBytes: number): string {
  const seen = new Set<object>()
  const encoder = new TextEncoder()
  let output = ''
  let size = 0
  let current = error
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current)
    const code = 'code' in current && typeof current.code === 'string' ? current.code : ''
    const name = 'name' in current && typeof current.name === 'string' ? current.name : ''
    const message = 'message' in current && typeof current.message === 'string' ? current.message : ''
    const line = redactUrls(`${output === '' ? '' : '\n'}${code}${code === '' ? '' : ' | '}${name}: ${message}`)
    for (const char of line) {
      const bytes = encoder.encode(char).byteLength
      if (size + bytes > maxBytes) return output
      output += char
      size += bytes
    }
    current = 'cause' in current ? current.cause : undefined
  }
  return output
}
