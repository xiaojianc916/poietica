import { expect, test } from 'bun:test'
import { act, render } from '@testing-library/react'
import { TruncatedText } from '../truncated-text'

test('只有真的被裁掉时才把完整文本挂到 title', async () => {
  const view = render(<TruncatedText>deepseek-reasoner-with-a-long-name</TruncatedText>)
  const span = view.container.querySelector('span')
  if (span === null) throw new Error('没有渲染出 span')

  expect(span.getAttribute('title')).toBeNull()

  Object.defineProperty(span, 'scrollWidth', { configurable: true, value: 240 })
  Object.defineProperty(span, 'clientWidth', { configurable: true, value: 120 })
  await act(async () => {
    window.dispatchEvent(new Event('resize'))
  })

  expect(span.getAttribute('title')).toBe('deepseek-reasoner-with-a-long-name')
})
