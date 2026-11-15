/** Build the standalone plugin with the official module-table preset; no runtime checkout paths remain. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { TsdownPlugin } from 'tsdown'
import { clientBundle } from '../packages/client/tsdown.client.ts'

const require = createRequire(import.meta.url)
const standalonePath = require.resolve('defuddle/full')
const standalone = readFileSync(standalonePath, 'utf8')
const noticePath = fileURLToPath(new URL('./NOTICE', import.meta.url))
const notice = readFileSync(noticePath, 'utf8')
const base = clientBundle(import.meta.dirname, ['index.mjs'], {
  clientBanner: () => `/*! ${notice.replaceAll('*/', '* /')} */`,
})
const guestArticle: TsdownPlugin = {
  name: 'browser-context-article-standalone',
  transform(code, id) {
    if (!/[\\/]readers[\\/]article\.[jt]s$/.test(id)) return
    this.addWatchFile(standalonePath)
    this.addWatchFile(noticePath)
    return { code: code.replace(/declare const __BROWSER_CONTEXT_DEFUDDLE__: string\s*/, '')
      .replaceAll('__BROWSER_CONTEXT_DEFUDDLE__', () => JSON.stringify(standalone)), map: null }
  },
}
const portableModuleComments: TsdownPlugin = {
  name: 'browser-context-portable-module-comments',
  renderChunk(code) {
    return { code: code.replace(/^\/\/#region [^\r\n]*dsh-css:[^\r\n]*[/\\]([^/\\\r\n]+)$/gmu, '//#region dsh-css:$1'), map: null }
  },
}
export default (options: Parameters<typeof base>[0]) => base(options).map(config => ({
  ...config, sourcemap: false, plugins: [config.plugins, guestArticle, portableModuleComments],
}))
