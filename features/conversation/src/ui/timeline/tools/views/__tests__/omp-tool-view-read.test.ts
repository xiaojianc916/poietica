import { describe, expect, test } from 'bun:test'
import { toolGlyphOf } from '../../../../shared/tools/omp-tool-glyphs'
import { toolFamilyOf } from '../../../../shared/tools/tool-family'
import { ompToolView } from '../../omp-tool-view'

/*
 * read 是传输工具：读的是什么由地址说。折叠行的动词、字形、分族三处必须给同一个答案 ——
 * 「脑子图标 + 阅读 memory://… + 并进已读取文件那一组」就是三处各说各话。
 */

function readOf(path: string, tool = 'read') {
  const view = ompToolView(tool, { path }, null)

  return { family: toolFamilyOf(view), glyph: toolGlyphOf(view.invokedTool, view.scheme), view }
}

describe('read 按地址说话', () => {
  test('记忆：动词是「读取记忆」，字形是记忆，归记忆族而不是过程', () => {
    const { family, glyph, view } = readOf('memory://root/memory_summary.md')

    expect(view.headline).toBe('读取记忆 root/memory_summary.md')
    expect(glyph).toBe('memory')
    expect(family.key).toBe('memory')
  })

  test('技能：动词是「读取技能」，归技能族', () => {
    const { family, view } = readOf('skill://ponytail')

    expect(view.headline).toBe('读取技能 ponytail')
    expect(family.key).toBe('skill')
  })

  test('网页：read https:// 与 fetch 都是「抓取」，类别是 fetch，归网页族', () => {
    const read = readOf('https://example.com/a')
    const fetched = ompToolView('fetch', { url: 'https://example.com/b' }, null)

    expect(read.view.headline).toBe('抓取 https://example.com/a')
    expect(read.view.kind).toBe('fetch')
    expect(read.family.key).toBe('web')
    expect(fetched.headline).toBe('抓取 https://example.com/b')
    expect(fetched.kind).toBe('fetch')
    expect(toolGlyphOf(fetched.invokedTool, fetched.scheme)).toBe('fetch')
    expect(toolFamilyOf(fetched).key).toBe('web')
  })

  test('本地文件与资源地址照旧「阅读」，留在过程组', () => {
    const file = readOf('src/a.ts')
    const local = readOf('local://PLAN.md')

    expect(file.view.headline).toBe('阅读 src/a.ts')
    expect(file.family.key).toBe('process')
    expect(local.view.headline).toBe('阅读 local://PLAN.md')
    expect(local.family.key).toBe('process')
  })
})

describe('分族的边界', () => {
  test('recall 自报 search，但它是记忆，不并进代码搜索', () => {
    expect(toolFamilyOf({ invokedTool: 'recall', kind: 'search', scheme: '' }).key).toBe('memory')
  })

  test('lsp 自报 read，但它有自己的字形，自成一族', () => {
    expect(toolFamilyOf({ invokedTool: 'lsp', kind: 'read', scheme: '' }).key).toBe('lsp')
  })

  test('python / js / eval 是运行命令，进过程组', () => {
    for (const name of ['python', 'js', 'eval', 'bash']) {
      expect(toolFamilyOf({ invokedTool: name, kind: 'execute', scheme: '' })).toEqual({
        key: 'process',
        facet: 'execute',
      })
    }
  })

  test('认不出的工具不按 kind 猜进过程组，只与同名工具成组', () => {
    expect(toolFamilyOf({ invokedTool: 'mystery', kind: 'read', scheme: '' }).key).toBe('tool:mystery')
  })
})
