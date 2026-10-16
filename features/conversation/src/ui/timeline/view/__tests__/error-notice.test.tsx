import { expect, test } from 'bun:test'
import { cleanup, render } from '@testing-library/react'
import { ErrorNotice } from '../error-notice'

/* 两档（R-09）：error 用 alert，warning 用 status —— status 不打断读屏。 */

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
