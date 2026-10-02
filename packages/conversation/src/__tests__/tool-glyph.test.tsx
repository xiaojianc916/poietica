import { describe, expect, it } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolGlyphIcon } from '../surface/timeline/tool-call-card'

/*
 * 折叠行上那一枚字形认谁。
 *
 * 默认认名字；read/write 是传输工具，名字回答不了「在读文件还是读技能」，那时候认地址。
 * 这里钉的就是这两条 —— 表错了屏幕上只能看出一枚不对的字形，看不出是哪一行错的。
 */
describe('工具字形认名字', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['bash', 'square-terminal'],
    ['read', 'book-open-text'],
    ['edit', 'pencil'],
    ['write', 'pencil'],
    ['grep', 'search'],
    ['web_search', 'globe'],
    ['lsp', 'square-dashed-bottom-code'],
    ['computer', 'computer'],
    ['browser', 'computer'],
    ['debug', 'bug'],
    ['security_scan', 'bug'],
    ['ask', 'circle-question-mark'],
    ['wait', 'rotate-cw-fading-clock'],
    ['checkpoint', 'viewBox="0 0 16 16"'],
    ['rewind', 'viewBox="0 0 16 16"'],
    ['github', 'viewBox="0 0 16 16"'],
    ['retain', 'brain'],
    ['recall', 'brain'],
    ['reflect', 'brain'],
    ['memory_edit', 'brain'],
    ['learn', 'brain-circuit'],
    ['manage_skill', 'zap'],
    ['yield', 'circle-dot-dashed'],
    ['generate_image', 'image'],
    ['tts', 'mic'],
    ['resolve', 'rotate-ccw-square'],
    ['reject', 'rotate-ccw-square'],
    ['report_issue', 'rotate-ccw-square'],
    ['task', 'scan-search'],
    ['todo', 'list-todo'],
    ['goal', 'target'],
    ['think', 'layers'],
    ['context_notes', 'layers'],
    ['new_context', 'layers'],
    ['mcp__github_create_issue', 'unplug'],
    ['init_experiment', 'unplug'],
  ]

  /* 描边字形带 lucide-<名> 这个类；GitHub 是品牌标记（实心、16 视口），只认它的画布。 */
  for (const [name, glyph] of cases) {
    it(`${name} → ${glyph}`, () => {
      const markup = renderToStaticMarkup(<ToolGlyphIcon name={name} />)
      const expected = glyph.startsWith('viewBox') ? glyph : `lucide-${glyph}`

      expect(markup).toContain(expected)
    })
  }

  it('名字大小写不影响', () => {
    expect(renderToStaticMarkup(<ToolGlyphIcon name="BASH" />)).toContain('lucide-square-terminal')
  })
})

/*
 * 截图里的那一行：`read skill://ponytail` 是装载技能，不是读文件。
 * read/write 是 omp 的传输工具（XDEV_TRANSPORT_TOOLS 恰好就是这两个），
 * 说什么由地址决定 —— 名字里没有这个信息。
 */
describe('传输工具认地址', () => {
  const cases: readonly (readonly [string, string, string])[] = [
    ['read', 'skill', 'zap'],
    ['read', 'memory', 'brain'],
    ['read', 'agent', 'scan-search'],
    ['read', 'rule', 'book-open-text'],
    ['read', 'artifact', 'book-open-text'],
    ['read', 'omp', 'book-open-text'],
    ['read', 'history', 'book-open-text'],
    ['read', 'local', 'book-open-text'],
    ['read', 'ssh', 'book-open-text'],
    ['read', 'vault', 'book-open-text'],
    ['read', 'security', 'bug'],
    ['read', 'issue', 'viewBox="0 0 16 16"'],
    ['read', 'pr', 'viewBox="0 0 16 16"'],
    ['read', 'proc', 'square-terminal'],
    ['read', 'mcp', 'unplug'],
    ['read', 'https', 'globe'],
    ['read', 'http', 'globe'],
    ['write', 'xd', 'rotate-ccw-square'],
    ['write', 'conflict', 'pencil'],
  ]

  for (const [name, scheme, glyph] of cases) {
    it(`${name} ${scheme}:// → ${glyph}`, () => {
      const markup = renderToStaticMarkup(<ToolGlyphIcon name={name} scheme={scheme} />)
      const expected = glyph.startsWith('viewBox') ? glyph : `lucide-${glyph}`

      expect(markup).toContain(expected)
    })
  }

  it('没有地址时传输工具仍按名字给', () => {
    expect(renderToStaticMarkup(<ToolGlyphIcon name="read" />)).toContain('lucide-book-open-text')
    expect(renderToStaticMarkup(<ToolGlyphIcon name="write" />)).toContain('lucide-pencil')
  })

  it('地址只改传输工具，别的工具名字说了算', () => {
    expect(renderToStaticMarkup(<ToolGlyphIcon name="bash" scheme="skill" />)).toContain(
      'lucide-square-terminal',
    )
  })

  it('表外的 scheme 不把一次写入说成外来工具', () => {
    expect(renderToStaticMarkup(<ToolGlyphIcon name="write" scheme="db" />)).toContain(
      'lucide-pencil',
    )
  })

  /*
   * 「一份东西」的 scheme 只说碰的是哪类资源，干什么由动词说：
   * write local://PLAN.md 是写，不能因为 local 是「本地文件」就画成书。
   */
  it('同一份资源，读与写画各自的动词', () => {
    for (const scheme of ['local', 'ssh', 'vault', 'artifact', 'rule', 'omp', 'history']) {
      expect(renderToStaticMarkup(<ToolGlyphIcon name="read" scheme={scheme} />)).toContain(
        'lucide-book-open-text',
      )
      expect(renderToStaticMarkup(<ToolGlyphIcon name="write" scheme={scheme} />)).toContain(
        'lucide-pencil',
      )
    }
  })
})
