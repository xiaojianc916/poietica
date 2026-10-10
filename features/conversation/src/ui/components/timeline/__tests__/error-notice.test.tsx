import { expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { ErrorNotice } from '../error-notice'

/*
 * 报错条的两档样子（R-09）：error 维持红色感叹号 + role=alert；
 * warning 换三角、安静色，role=status 不打断读屏。线与字都不变。
 */

test('E1 error 是 alert，复制按钮说的是「报错信息」', () => {
  const { container } = render(<ErrorNotice message="x" />)
  const row = container.querySelector('.timeline-error')
  expect(row?.getAttribute('data-level')).toBe('error')
  expect(row?.getAttribute('role')).toBe('alert')
  expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('复制完整报错信息')
  cleanup()
})

test('E2 warning 是 status，复制按钮说的是「提示信息」', () => {
  const { container } = render(<ErrorNotice level="warning" message="x" />)
  const row = container.querySelector('.timeline-error')
  expect(row?.getAttribute('data-level')).toBe('warning')
  expect(row?.getAttribute('role')).toBe('status')
  expect(container.querySelector('button')?.getAttribute('aria-label')).toBe('复制完整提示信息')
  cleanup()
})
