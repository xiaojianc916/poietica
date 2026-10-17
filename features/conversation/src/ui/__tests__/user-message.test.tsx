import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { USER_VIRTUAL_ABOVE_LINES, UserMessage } from '../timeline/view/user-message'

afterEach(cleanup)

/** 行数判据的样本：每行一个短词，不靠软换行凑高度。 */
function lines(count: number): string {
  return Array.from({ length: count }, (_, at) => `第 ${String(at + 1)} 行`).join('\n')
}

/*
 * 文件在输入框里是正文里的一枚记号（文件、元素拾取的报告都是）：发出去之后气泡里画同一枚记号，
 * 不能只剩那句话 —— 模型收得到、人却看不见自己发了什么。图片照旧排在气泡上面。
 */
describe('用户气泡里的附件', () => {
  test('文件画成气泡里的记号，排在原文之前', () => {
    const view = render(
      <UserMessage files={[{ name: 'poietica-tool-grouping.patch', meta: 'PATCH' }]} text="你可以看见吗" />,
    )
    const said = view.container.querySelector('.timeline-user__text')

    expect(said?.querySelector('.assistant-prompt-chip')?.getAttribute('title')).toBe('poietica-tool-grouping.patch')
    expect(said?.textContent).toBe('poietica-tool-grouping.patch你可以看见吗')
    expect(view.container.querySelector('.timeline-files')).toBeNull()
  })

  test('只发了文件没写字：气泡照样在，里面是那枚记号', () => {
    const view = render(<UserMessage files={[{ name: 'div.md', meta: 'MD' }]} text="" />)

    expect(view.container.querySelector('.timeline-user .assistant-prompt-chip')?.textContent).toBe('div.md')
  })

  test('图片仍在气泡外面那一排', () => {
    const view = render(<UserMessage images={[{ url: 'data:image/png;base64,AAAA' }]} text="看图" />)

    expect(view.container.querySelector('.timeline-attachments')).not.toBeNull()
    expect(view.container.querySelector('.timeline-user .assistant-prompt-chip')).toBeNull()
  })
})

/*
 * 太长了自己滚，不再有「展开全部」：短句一颗键都不该有，长句要戴 data-scrollable 让
 * feed/nested-scroll.ts 认得这是行内滚动的盒子，滚到边界才把滚轮交还给转录视口。
 */
describe('用户气泡的高度', () => {
  test('短句不滚，也不带那颗键', () => {
    const view = render(<UserMessage text="两行足矣\n第二行" />)
    const said = view.container.querySelector('.timeline-user__text')

    expect(said?.hasAttribute('data-scrollable')).toBe(false)
    expect(view.container.querySelector('button')).toBeNull()
  })

  test('封顶那档刚好是七行：第八行才滚', () => {
    const seven = render(<UserMessage text={lines(7)} />).container.querySelector('.timeline-user__text')
    const eight = render(<UserMessage text={lines(8)} />).container.querySelector('.timeline-user__text')

    expect(seven?.hasAttribute('data-scrollable')).toBe(false)
    expect(eight?.hasAttribute('data-scrollable')).toBe(true)
  })

  test('超过七行就自己滚', () => {
    const view = render(<UserMessage text={lines(10)} />)
    const said = view.container.querySelector('.timeline-user__text')

    expect(said?.hasAttribute('data-scrollable')).toBe(true)
    /* 展开全部已经撤掉，气泡里不再有任何按钮。 */
    expect(view.container.querySelector('button')).toBeNull()
    expect(view.container.textContent).toContain('第 10 行')
  })

  test('五十行起虚拟化：整段不进 DOM', () => {
    const view = render(<UserMessage text={lines(USER_VIRTUAL_ABOVE_LINES)} />)
    const rendered = view.container.querySelectorAll('.timeline-user__line').length

    expect(view.container.querySelector('.timeline-user__output')).not.toBeNull()
    /* 虚拟器只铺视口 ± overscan。happy-dom 量不出几何，这里钉的是「没有整段铺出来」：
       一旦退回整段渲染，行数会等于总行数、末行也会出现在 DOM 里。 */
    expect(rendered).toBeLessThan(USER_VIRTUAL_ABOVE_LINES)
    expect(view.container.textContent).not.toContain(`第 ${String(USER_VIRTUAL_ABOVE_LINES)} 行`)
  })

  test('虚拟化的那一档，记号留在滚动盒外面', () => {
    const view = render(<UserMessage files={[{ name: 'div.md', meta: 'MD' }]} text={lines(USER_VIRTUAL_ABOVE_LINES)} />)
    const chips = view.container.querySelector('.timeline-user__chips')
    const scroller = view.container.querySelector('.timeline-user__text[data-scrollable]')

    expect(chips?.textContent).toBe('div.md')
    /* 跟着行走就会随滚动消失：记号不属于任何一行。 */
    expect(scroller?.contains(chips ?? null)).toBe(false)
  })
})
