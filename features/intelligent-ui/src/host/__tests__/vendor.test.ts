import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { INTELLIGENT_UI_LIBRARIES, intelligentUiLibraryUrls, intelligentUiVendorUrl } from '../../contract'
import { createShellHandler } from '../shell'
import { librariesUsedBy, vendorText } from '../vendor'

/*
 * 随包库：契约里的清单、本包的依赖、仓库的 catalog、装出来的那一份，四处的版本必须一致 ——
 * 外壳只按「精确地址」替换，版本差一位，模型照指南写的地址就会去走 CDN（离线时直接坏掉）。
 */

const root = path.resolve(import.meta.dir, '../../../../..')
const feature = path.resolve(import.meta.dir, '../../..')

function json(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
}

describe('随包库', () => {
  test('V1 版本：契约 = catalog = 装出来的那份；本包按 catalog 依赖它们', () => {
    const catalog = (json(path.join(root, 'package.json')).workspaces as { catalog: Record<string, string> }).catalog
    const dependencies = json(path.join(feature, 'package.json')).dependencies as Record<string, string>
    for (const library of INTELLIGENT_UI_LIBRARIES) {
      expect(catalog[library.name]).toBe(library.version)
      expect(dependencies[library.name]).toBe('catalog:')
      const installed = json(path.join(feature, 'node_modules', library.name, 'package.json'))
      expect(installed.version).toBe(library.version)
      expect(installed.license).toBe(library.license)
      expect(library.asset).toContain(library.version)
    }
  })

  test('V2 正文：是那个 UMD 文件（挂对全局），去掉了 sourceMappingURL；清单外的名字一律没有', () => {
    for (const library of INTELLIGENT_UI_LIBRARIES) {
      const text = vendorText(library.asset)
      const original = readFileSync(path.join(feature, 'node_modules', library.name, library.file), 'utf8')
      expect(text).not.toBeNull()
      expect(text).not.toContain('sourceMappingURL')
      expect(text?.length).toBeGreaterThan(original.length - 200)
      expect(text?.length).toBeLessThanOrEqual(original.length + 1)
      expect(text).toContain(library.global)
    }
    expect(vendorText('d3.min.js')).toBeNull()
    expect(vendorText('../package.json')).toBeNull()
    expect(vendorText('')).toBeNull()
  })

  test('V3 资源协议：vendor/<asset> 回脚本；外壳之外只有这一段', async () => {
    const handler = createShellHandler()
    const library = INTELLIGENT_UI_LIBRARIES[0]
    if (library === undefined) throw new Error('清单是空的')
    expect(intelligentUiVendorUrl(library)).toBe(`poietica-asset://intelligent-ui/vendor/${library.asset}`)
    const request = new Request(intelligentUiVendorUrl(library))
    const ok = await handler(['vendor', library.asset], request)
    expect(ok.status).toBe(200)
    expect(ok.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('*')
    /* 文件名带版本、同名同字节：不覆盖资源协议默认的 immutable */
    expect(ok.headers.get('Cache-Control')).toBeNull()
    expect(await ok.text()).toBe(vendorText(library.asset) ?? '')
    for (const segments of [['vendor'], ['vendor', 'nope.js'], ['vendor', library.asset, 'x'], [library.asset]]) {
      expect((await handler(segments, request)).status).toBe(404)
    }
  })

  test('V4 精确地址：jsDelivr 与 unpkg 两种写法；导出时只挑界面里出现的那几个', () => {
    const d3 = INTELLIGENT_UI_LIBRARIES.find((library) => library.name === 'd3')
    if (d3 === undefined) throw new Error('清单里没有 d3')
    expect(intelligentUiLibraryUrls(d3)).toEqual([
      'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js',
      'https://unpkg.com/d3@7.9.0/dist/d3.min.js',
    ])
    const html = `<script src="https://unpkg.com/chart.js@4.5.1/dist/chart.umd.min.js"></script><script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>`
    expect(librariesUsedBy(html, intelligentUiLibraryUrls).map((library) => library.name)).toEqual(['chart.js'])
  })

  test('V5 只认 <script src>：注释/正文里的地址不内嵌；大小写、空白、引号容忍；带 integrity 也算', () => {
    const d3Url = 'https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js'
    const commentOnly = `<!-- <script src="${d3Url}"></script> --><p>示例：${d3Url}</p><pre>&lt;script src="${d3Url}"&gt;</pre>`
    expect(librariesUsedBy(commentOnly, intelligentUiLibraryUrls)).toEqual([])

    const textOnly = `<script>var sample = '<script src="${d3Url}"></script>'</script><p data-note="${d3Url}">${d3Url}</p>`
    expect(librariesUsedBy(textOnly, intelligentUiLibraryUrls)).toEqual([])

    const spaced = `<SCRIPT  SRC = "${d3Url}"  integrity="sha384-x" crossorigin="anonymous"></SCRIPT>`
    expect(librariesUsedBy(spaced, intelligentUiLibraryUrls).map((library) => library.name)).toEqual(['d3'])

    const single = `<script src='${d3Url}' integrity='sha384-x'></script>`
    expect(librariesUsedBy(single, intelligentUiLibraryUrls).map((library) => library.name)).toEqual(['d3'])

    const bare = `<script src=${d3Url} async></script>`
    expect(librariesUsedBy(bare, intelligentUiLibraryUrls).map((library) => library.name)).toEqual(['d3'])
  })
})
