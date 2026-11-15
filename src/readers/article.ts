/** Official browser-only Defuddle, embedded as data at build time and executed only on explicit capture. */
import type Defuddle from 'defuddle/full'

// The package-local build replaces this token with the installed official standalone distribution.
declare const __BROWSER_CONTEXT_DEFUDDLE__: string

function readArticle(Parser: typeof Defuddle, maxBytes: number): object {
  const url = document.URL
  const address = new URL(url)
  const contentSelector = (address.hostname === 'www.yzwb.net' || address.hostname === 'yzwb.net') && /^\/news\/.+\.html$/.test(address.pathname)
    ? '#con.art_txt'
    : address.hostname === 'mp.weixin.qq.com' && /^\/s(?:\/|$)/.test(address.pathname) ? '#js_content' : undefined
  function hidden(element: Element): boolean {
    const style = window.getComputedStyle(element)
    return element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true'
      || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || style.opacity === '0'
  }
  // Defuddle normalizes its argument before its own clone, so the live document is never its input.
  const clone = document.cloneNode(true) as Document
  let scope: Element | undefined
  if (contentSelector !== undefined) {
    const root = document.querySelector(contentSelector)
    if (root === null) return { code: 'no-article' }
    for (let ancestor: Element | null = root; ancestor !== null; ancestor = ancestor.parentElement) {
      if (hidden(ancestor)) return { code: 'no-article' }
    }
    scope = root.cloneNode(true) as Element
    const originals = [...root.querySelectorAll('*')]
    const copies = [...scope.querySelectorAll('*')]
    for (const [index, element] of originals.entries()) {
      const copy = copies[index]
      if (copy !== undefined && scope.contains(copy) && hidden(element)) copy.remove()
    }
    // Retries must not expand into sidebars, hidden alternative content, or schema article bodies.
    clone.body.replaceChildren(scope)
    for (const script of clone.querySelectorAll('script')) script.remove()
  }
  const result = new Parser(clone, {
    url, markdown: true, useAsync: false, debug: true, ...(contentSelector === undefined ? {} : { contentSelector }),
    fetch: () => { throw new Error('Article capture does not fetch resources') },
  }).parse()
  const selector = result.debug?.contentSelector
  const container = selector?.split(' > ').at(-1)
  if ((result.debug?.errors?.length ?? 0) > 0
    || (container === undefined && result.extractorType === undefined)
    || (container !== undefined && /^(?:body|html)(?:[.#]|$)/.test(container))) return { code: 'no-article' }
  if (scope !== undefined) {
    if (container === undefined || container.trim() === '') return { code: 'no-article' }
    try {
      if (!scope.matches(container) && scope.querySelector(container) === null) return { code: 'no-article' }
    } catch (_error) { return { code: 'no-article' } } // An unresolvable library selector cannot establish the requested article scope.
  }
  const text = result.content.trim()
  if (text.length === 0 || result.wordCount === 0) return { code: 'no-article' }
  const title = result.title || (contentSelector === '#js_content' ? document.querySelector('#activity-name')?.textContent?.trim() : '') || document.title
  const capture = { kind: 'article', url, title, text, format: 'markdown' }
  if (text.length > maxBytes || new TextEncoder().encode(JSON.stringify(capture)).byteLength > maxBytes) {
    return { code: 'too-large' }
  }
  return capture
}

/** @param maxBytes - validated complete result budget. @returns a fixed local guest extraction script. */
export function articleScript(maxBytes: number): string {
  return `(() => {
    const module = { exports: {} }; const exports = module.exports;
    const console = { log() {}, info() {}, warn() {}, error() {}, debug() {}, time() {}, timeEnd() {} };
    ${__BROWSER_CONTEXT_DEFUDDLE__}
    return (${readArticle.toString()})(module.exports, ${JSON.stringify(maxBytes)});
  })()`
}
