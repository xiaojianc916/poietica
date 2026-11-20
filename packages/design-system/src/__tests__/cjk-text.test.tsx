import { expect, test } from 'bun:test'
import { render } from '@testing-library/react'
import { CjkText } from '../cjk-text'

test('中文标题在词与词之间插 wbr，英文原样', () => {
  const cn = render(
    <h1>
      <CjkText>新建定时任务</CjkText>
    </h1>,
  )
  expect(cn.container.querySelectorAll('wbr').length).toBeGreaterThan(0)
  expect(cn.container.textContent).toBe('新建定时任务')

  const en = render(
    <h1>
      <CjkText>Code review</CjkText>
    </h1>,
  )
  expect(en.container.querySelectorAll('wbr').length).toBe(0)
  expect(en.container.textContent).toBe('Code review')
})
