// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

interface BuildTestFace {
  readonly default: (options: { env: { DSH_BUILD_FACE: string } }) => readonly { readonly platform?: string; readonly plugins?: unknown }[]
}

describe('standalone article bundle embedding', () => {
  it('embeds the installed UMD verbatim without interpreting replacement dollar sequences', async () => {
    const require = createRequire(import.meta.url)
    const standalone = readFileSync(require.resolve('defuddle/full'), 'utf8')
    const config = await vi.importActual<BuildTestFace>('../tsdown.config.ts')
    const client = config.default({ env: { DSH_BUILD_FACE: 'client' } }).find(item => item.platform === 'browser')
    if (client === undefined || !Array.isArray(client.plugins)) throw new Error('Client plugins are required')
    const plugins: readonly unknown[] = client.plugins.flat(Infinity)
    const plugin = plugins.find(value => typeof value === 'object' && value !== null && 'name' in value
      && value.name === 'browser-context-article-standalone')
    if (typeof plugin !== 'object' || plugin === null || !('transform' in plugin) || typeof plugin.transform !== 'function') throw new Error('Article transform is required')
    const addWatchFile = vi.fn()
    const transform = (code: string, id: string): unknown => Reflect.apply(plugin.transform, { addWatchFile }, [code, id])
    const source = 'declare const __BROWSER_CONTEXT_DEFUDDLE__: string\nexport const bundle = __BROWSER_CONTEXT_DEFUDDLE__'
    for (const id of ['E:/plugin/src/readers/article.ts', 'E:\\plugin\\src\\readers\\article.ts', 'E:/plugin/lib/types/readers/article.js']) {
      expect(await transform(source, id)).toMatchObject({ code: `export const bundle = ${JSON.stringify(standalone)}` })
    }
    expect(transform('unchanged', 'E:/plugin/src/client/index.ts')).toBeUndefined()
    expect(addWatchFile).toHaveBeenCalledWith(require.resolve('defuddle/full'))
  })
})
