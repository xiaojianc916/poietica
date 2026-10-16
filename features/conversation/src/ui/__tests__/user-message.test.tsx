import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { UserMessage } from '../timeline/view/user-message'

afterEach(cleanup)

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
