// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import type Defuddle from 'defuddle/full'
import { articleScript } from '../src/readers/article.ts'

const require = createRequire(import.meta.url)
const standalone = readFileSync(require.resolve('defuddle/full'), 'utf8')
const article = `<!doctype html><html><head><title>Standalone article</title></head><body>
<nav><a href="/login">Navigation only</a></nav><main><article><h1>Standalone article</h1>
<p>${'This paragraph describes a useful independent document reader and its bounded local extraction. '.repeat(8)}</p>
<h2>Details</h2><p>${'The page body remains unchanged and outside scripts are not executed by extraction. '.repeat(8)}</p>
<ul><li><p>First detail explains how explicit page extraction keeps model input bounded and allows the user to inspect the complete captured reference before sending it.</p></li><li><p>Second detail explains that image URLs remain links and that extraction never claims to download the images or read an entire cloud document.</p></li></ul><table><tr><th>Item</th><th>Value</th></tr><tr><td>Local</td><td>Only</td></tr></table>
<p><a href="/related">Related link</a><img src="/diagram.png" alt="Diagram"></p>
</article></main><footer>Footer navigation</footer><script>window.pageScriptExecuted = true</script></body></html>`

function page(html: string, url = 'https://example.test/article') {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' })
  Reflect.set(dom.window, 'TextEncoder', TextEncoder)
  const fetch = vi.fn(() => { throw new Error('No resource fetch is allowed') })
  Reflect.set(dom.window, 'fetch', fetch)
  return { dom, fetch }
}

const chineseParagraphs = Array.from({ length: 12 }, (_, index) =>
  `<p>匿名段落${index + 1}：${'这是一篇虚构的中文报道，记录社区阅读活动的组织过程。参与者分享阅读体验，讨论公共空间的使用方式，并为下一次活动提出建议。'.repeat(3)}</p>`,
).join('')
const markdownDetails = `<ul><li><p>匿名清单甲：参与者提前登记阅读主题，活动组织人员整理匿名建议，安排交流时间，并提供适合不同年龄读者使用的阅读资料。</p></li><li><p>匿名清单乙：参与者在交流结束后共同整理活动空间，记录后续阅读计划，并将公共资料归还到原来的位置以便其他读者继续使用。</p></li></ul>
<table><thead><tr><th>项目</th><th>说明</th></tr></thead><tbody><tr><td>阅读</td><td>分享</td></tr></tbody></table>
<p><a href="https://example.test/reference">匿名参考资料</a><img src="https://example.test/anonymous.png" alt="匿名插图"></p>`
const yzwb = `<!doctype html><html><head><title>浏览器标题</title><meta property="og:title" content="匿名新闻标题"></head>
<body id="body_wryh"><header><nav>站点导航哨兵</nav></header><h1>匿名新闻标题</h1>
<div id="con" class="art_txt">${chineseParagraphs}${markdownDetails}</div>
<aside><p>相邻侧栏哨兵${'推荐访问其他频道，查看历史活动资讯。'.repeat(30)}</p></aside>
<footer>页脚哨兵</footer><script>window.pageScriptExecuted = true</script></body></html>`
const wechat = `<!doctype html><html><head><title>浏览器标题</title><meta property="og:title" content="匿名公众号标题"></head>
<body id="activity-detail"><nav>公众号导航哨兵</nav><h1 id="activity-name">匿名公众号标题</h1>
<div id="js_content" class="rich_media_content"><section id="mdnice" style="font-size: 16px; line-height: 1.75;">
${chineseParagraphs.replaceAll('<p>', '<p style="text-align: justify;"><span style="color: rgb(51, 51, 51);">').replaceAll('</p>', '</span></p>')}
${markdownDetails}</section></div><aside>公众号侧栏哨兵</aside><footer>公众号页脚哨兵</footer>
<script>window.pageScriptExecuted = true</script></body></html>`

function officialResult(dom: JSDOM): ReturnType<Defuddle['parse']> {
  return runInContext(`(() => {
    const module = { exports: {} }; const exports = module.exports;
    const console = { log() {}, info() {}, warn() {}, error() {}, debug() {}, time() {}, timeEnd() {} };
    ${standalone}
    return new module.exports(document.cloneNode(true), {
      url: document.URL, markdown: true, useAsync: false, debug: true,
      fetch() { throw new Error('No resource fetch is allowed'); },
    }).parse();
  })()`, dom.getInternalVMContext())
}

describe('standalone article capture', () => {
  beforeEach(() => { vi.stubGlobal('__BROWSER_CONTEXT_DEFUDDLE__', standalone) })
  afterEach(() => { vi.unstubAllGlobals() })
  it('executes the official distribution with Markdown and no page mutation or resource fetch', () => {
    const { dom, fetch } = page(article)
    try {
      const before = dom.window.document.documentElement.outerHTML
      const observer = new dom.window.MutationObserver(() => {})
      observer.observe(dom.window.document, { subtree: true, childList: true, attributes: true, characterData: true })
      const result: unknown = runInContext(articleScript(65536), dom.getInternalVMContext())
      expect(result).toMatchObject({ kind: 'article', url: 'https://example.test/article', format: 'markdown' })
      if (typeof result !== 'object' || result === null || !('text' in result) || typeof result.text !== 'string') throw new Error('Article text is required')
      expect(result.text).toContain('## Details')
      expect(result.text).toContain('First detail')
      expect(result.text).toContain('https://example.test/related')
      expect(result.text).toContain('https://example.test/diagram.png')
      expect(result.text).not.toContain('Navigation only')
      expect(result.text).not.toContain('Footer navigation')
      expect(dom.window.document.documentElement.outerHTML).toBe(before)
      expect(observer.takeRecords()).toEqual([])
      observer.disconnect()
      expect(Reflect.get(dom.window, 'pageScriptExecuted')).toBeUndefined()
      expect(Reflect.get(dom.window, 'Defuddle')).toBeUndefined()
      expect(fetch).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })
  it('rejects whole-body fallback instead of calling menu text an article', () => {
    const { dom } = page('<html><head><title>Menu</title></head><body><nav><a href="/a">Home</a><a href="/b">Settings</a></nav></body></html>')
    try { expect(runInContext(articleScript(65536), dom.getInternalVMContext())).toMatchObject({ code: 'no-article' }) }
    finally { dom.window.close() }
  })
  it.each([
    ['https://www.yzwb.net/news/anonymous.html', yzwb, '匿名新闻标题'],
    ['https://yzwb.net/news/local/anonymous.html', yzwb, '匿名新闻标题'],
    ['https://mp.weixin.qq.com/s?__biz=anonymous&mid=123', wechat, '匿名公众号标题'],
    ['https://mp.weixin.qq.com/s/anonymous', wechat, '匿名公众号标题'],
  ])('extracts the confirmed Chinese template root at %s', (url, html, title) => {
    const { dom, fetch } = page(html, url)
    const observer = new dom.window.MutationObserver(() => {})
    try {
      const before = dom.window.document.documentElement.outerHTML
      observer.observe(dom.window.document, { subtree: true, childList: true, attributes: true, characterData: true })
      const result: unknown = runInContext(articleScript(65536), dom.getInternalVMContext())
      expect(result).toMatchObject({ kind: 'article', url, title, format: 'markdown' })
      if (typeof result !== 'object' || result === null || !('text' in result) || typeof result.text !== 'string') throw new Error('Article text is required')
      expect(result.text).toContain('匿名段落1')
      expect(result.text).toContain('匿名段落12')
      expect(result.text).toMatch(/[-*] 匿名清单甲/)
      expect(result.text).toContain('| 项目 | 说明 |')
      expect(result.text).toContain('[匿名参考资料](https://example.test/reference)')
      expect(result.text).toContain('![匿名插图](https://example.test/anonymous.png)')
      expect(result.text).not.toMatch(/导航哨兵|侧栏哨兵|页脚哨兵/)
      const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
      expect(runInContext(articleScript(bytes), dom.getInternalVMContext())).toEqual(result)
      expect(runInContext(articleScript(bytes - 1), dom.getInternalVMContext())).toMatchObject({ code: 'too-large' })
      expect(dom.window.document.documentElement.outerHTML).toBe(before)
      expect(observer.takeRecords()).toEqual([])
      expect(Reflect.get(dom.window, 'pageScriptExecuted')).toBeUndefined()
      expect(Reflect.get(dom.window, 'Defuddle')).toBeUndefined()
      expect(fetch).not.toHaveBeenCalled()
    } finally { observer.disconnect(); dom.window.close() }
  })
  it.each([
    ['https://www.yzwb.net/news/anonymous.html', '<div id="con"></div>'],
    ['https://yzwb.net/news/anonymous.html', '<div class="art_txt"></div>'],
    ['https://mp.weixin.qq.com/s', ''],
    ['https://mp.weixin.qq.com/s/anonymous', ''],
  ])('does not fall back to other prose when the template root is missing at %s', (url, decoy) => {
    const { dom } = page(article.replace('<main>', `${decoy}<main>`), url)
    try { expect(runInContext(articleScript(65536), dom.getInternalVMContext())).toMatchObject({ code: 'no-article' }) }
    finally { dom.window.close() }
  })
  it.each([
    'https://example.test/s/anonymous',
    'https://mp.weixin.qq.com/other',
    'https://mp.weixin.qq.com/something',
    'https://mp.weixin.qq.com.example.test/s',
    'https://www.yzwb.net/other/anonymous.html',
    'https://www.yzwb.net/news/anonymous',
    'https://www.yzwb.net.example.test/news/anonymous.html',
  ])('keeps ordinary article selection outside the fixed hostname/path scope at %s', (url) => {
    const { dom } = page(article.replace('<main>', '<div id="js_content"></div><div id="con" class="art_txt"></div><main>'), url)
    try {
      const result: unknown = runInContext(articleScript(65536), dom.getInternalVMContext())
      expect(result).toMatchObject({ kind: 'article' })
      if (typeof result !== 'object' || result === null || !('text' in result) || typeof result.text !== 'string') throw new Error('Article text is required')
      expect(result.text).toContain('This paragraph describes a useful independent document reader')
    } finally { dom.window.close() }
  })
  it.each([
    ['hidden root', '<div id="js_content" hidden>BODY</div>'],
    ['aria-hidden root', '<div id="js_content" aria-hidden="true">BODY</div>'],
    ['display-none root', '<div id="js_content" style="display: none">BODY</div>'],
    ['visibility-hidden root', '<div id="js_content" style="visibility: hidden">BODY</div>'],
    ['visibility-collapse root', '<div id="js_content" style="visibility: collapse">BODY</div>'],
    ['transparent root', '<div id="js_content" style="opacity: 0">BODY</div>'],
    ['hidden ancestor', '<section hidden><div id="js_content">BODY</div></section>'],
    ['stylesheet-hidden ancestor', '<style>.concealed { display: none; }</style><section class="concealed"><div id="js_content">BODY</div></section>'],
  ])('does not expose a known template through a %s', (_name, body) => {
    const { dom, fetch } = page(`<html><head><title>不可见文章</title></head><body>${body.replace('BODY', chineseParagraphs)}</body></html>`, 'https://mp.weixin.qq.com/s/hidden')
    try {
      const before = dom.window.document.documentElement.outerHTML
      expect(runInContext(articleScript(65536), dom.getInternalVMContext())).toMatchObject({ code: 'no-article' })
      expect(dom.window.document.documentElement.outerHTML).toBe(before)
      expect(fetch).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })
  it('does not let official retries recover hidden descendants or schema content outside the visible root', () => {
    const hidden = `<section hidden>${`<p>不可见段落哨兵${'未公开资料，不应输出。'.repeat(30)}</p>`.repeat(20)}</section>`
    const schema = `<script type="application/ld+json">${JSON.stringify({ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: '结构数据标题', articleBody: '结构数据正文哨兵。'.repeat(500) })}</script>`
    const html = wechat.replace('<section id="mdnice"', `${hidden}<section id="mdnice"`).replace('</head>', `${schema}</head>`)
    const { dom, fetch } = page(html, 'https://mp.weixin.qq.com/s/visible')
    try {
      const before = dom.window.document.documentElement.outerHTML
      const result: unknown = runInContext(articleScript(65536), dom.getInternalVMContext())
      expect(result).toMatchObject({ kind: 'article', title: '匿名公众号标题' })
      if (typeof result !== 'object' || result === null || !('text' in result) || typeof result.text !== 'string') throw new Error('Article text is required')
      expect(result.text).toContain('匿名段落12')
      expect(result.text).not.toMatch(/不可见段落哨兵|结构数据正文哨兵|导航哨兵|侧栏哨兵/)
      expect(dom.window.document.documentElement.outerHTML).toBe(before)
      expect(fetch).not.toHaveBeenCalled()
    } finally { dom.window.close() }
  })
  it.each([
    ['https://www.yzwb.net/news/empty.html', '<div id="con" class="art_txt"></div>'],
    ['https://mp.weixin.qq.com/s/empty', '<div id="js_content"></div>'],
  ])('rejects an empty fixed root rather than selecting another article at %s', (url, root) => {
    const { dom } = page(article.replace('<main>', `${root}<main>`), url)
    try { expect(runInContext(articleScript(65536), dom.getInternalVMContext())).toMatchObject({ code: 'no-article' }) }
    finally { dom.window.close() }
  })
  it('keeps unscoped whole-body candidates conservative even when the official parser returns prose', () => {
    const { dom } = page(`<!doctype html><html><head><title>匿名整页文章</title></head><body>${chineseParagraphs}</body></html>`)
    try {
      const parsed = officialResult(dom)
      expect(parsed.debug?.contentSelector).toBe('html > body')
      expect(parsed.debug?.errors ?? []).toEqual([])
      expect(parsed.wordCount).toBeGreaterThan(0)
      expect(parsed.content).toContain('匿名段落12')
      expect(runInContext(articleScript(65536), dom.getInternalVMContext())).toMatchObject({ code: 'no-article' })
    } finally { dom.window.close() }
  })
  it('rejects a long navigation-only menu instead of returning raw body text', () => {
    const menu = Array.from({ length: 100 }, (_, index) => `<li><a href="/channel/${index}">频道导航${index}：阅读更多分类资讯及历史活动</a></li>`).join('')
    const { dom } = page(`<html><head><title>频道目录</title></head><body><nav><ul>${menu}</ul></nav></body></html>`)
    try { expect(runInContext(articleScript(65536), dom.getInternalVMContext())).toMatchObject({ code: 'no-article' }) }
    finally { dom.window.close() }
  })
  it('rejects empty content from the official parser', () => {
    const { dom } = page('<!doctype html><html><head><title>Empty</title></head><body></body></html>')
    try { expect(runInContext(articleScript(65536), dom.getInternalVMContext())).toMatchObject({ code: 'no-article' }) }
    finally { dom.window.close() }
  })
  it('bounds the entire JSON at exact and undersized budgets without truncation', () => {
    const { dom } = page(article.replace('Standalone article', '独立文章'))
    try {
      const result: unknown = runInContext(articleScript(65536), dom.getInternalVMContext())
      const bytes = new TextEncoder().encode(JSON.stringify(result)).byteLength
      expect(runInContext(articleScript(bytes), dom.getInternalVMContext())).toEqual(result)
      expect(runInContext(articleScript(bytes - 1), dom.getInternalVMContext())).toMatchObject({ code: 'too-large' })
      expect(runInContext(articleScript(0), dom.getInternalVMContext())).toMatchObject({ code: 'too-large' })
    } finally { dom.window.close() }
  })
})
