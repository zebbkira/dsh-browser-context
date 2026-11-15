/** Fixed focused-frame selection reader, adapted from DSH ui-sidebar-browser (MIT, DeepSeek). */
function readSelection(maxBytes: number): { text: string } | { code: 'empty-selection' | 'too-large' } {
  let focused = document
  let active = focused.activeElement
  while (active?.tagName === 'IFRAME' || active?.tagName === 'FRAME') {
    let child: Document | null
    try { child = (active as HTMLIFrameElement).contentDocument }
    catch (_error) { return { code: 'empty-selection' } } // Respect the focused child's same-origin restriction.
    if (child === null) return { code: 'empty-selection' }
    focused = child
    active = focused.activeElement
  }
  let text: string
  if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') {
    const input = active as HTMLInputElement | HTMLTextAreaElement
    if (input.tagName === 'INPUT' && input.type === 'password') return { code: 'empty-selection' }
    const start = input.selectionStart
    const end = input.selectionEnd
    if (start === null || end === null || start === end) return { code: 'empty-selection' }
    if (end - start > maxBytes) return { code: 'too-large' }
    text = input.value.slice(start, end)
  } else text = focused.getSelection()?.toString() ?? ''
  if (text.length === 0) return { code: 'empty-selection' }
  if (text.length > maxBytes || new TextEncoder().encode(JSON.stringify({ text })).byteLength > maxBytes) return { code: 'too-large' }
  return { text }
}

/** @param maxBytes - validated byte budget. @returns fixed installed script with only a numeric invocation argument. */
export function selectionScript(maxBytes: number): string {
  return `(${readSelection.toString()})(${JSON.stringify(maxBytes)})`
}
