import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { Checkbox, Input, Radio, RowButton, Textarea } from '../index'

afterEach(() => {
  cleanup()
})

describe('表单原语', () => {
  test('Input 默认落 settings-input 词汇，variant=bare 不落', () => {
    render(
      <>
        <Input aria-label="默认" />
        <Input aria-label="裸" variant="bare" />
      </>,
    )

    expect(screen.getByRole('textbox', { name: '默认' }).className).toContain('settings-input')
    expect(screen.getByRole('textbox', { name: '裸' }).className).not.toContain('settings-input')
  })

  test('Input 转发 ref、受控值与 aria-invalid', () => {
    const ref = createRef<HTMLInputElement>()
    render(<Input aria-invalid aria-label="名称" defaultValue="poietica" ref={ref} />)

    expect(ref.current?.value).toBe('poietica')
    expect(screen.getByRole('textbox', { name: '名称' }).getAttribute('aria-invalid')).toBe('true')
  })

  test('Textarea 与 Input 同一套默认词汇', () => {
    render(
      <>
        <Textarea aria-label="默认" />
        <Textarea aria-label="裸" variant="bare" />
      </>,
    )

    expect(screen.getByRole('textbox', { name: '默认' }).className).toContain('settings-input')
    expect(screen.getByRole('textbox', { name: '裸' }).className).not.toContain('settings-input')
  })

  test('Checkbox 与 Radio 是原生控件，点击能换值', () => {
    render(
      <>
        <Checkbox aria-label="同意" />
        <Radio aria-label="甲" name="group" value="a" />
        <Radio aria-label="乙" name="group" value="b" />
      </>,
    )

    const checkbox = screen.getByRole('checkbox', { name: '同意' })
    fireEvent.click(checkbox)
    expect((checkbox as HTMLInputElement).checked).toBe(true)

    const second = screen.getByRole('radio', { name: '乙' })
    fireEvent.click(second)
    expect((second as HTMLInputElement).checked).toBe(true)
  })

  test('RowButton 默认 type=button，className 原样透传', () => {
    let clicks = 0
    render(
      <RowButton className="row-own" onClick={() => (clicks += 1)}>
        打开
      </RowButton>,
    )

    const button = screen.getByRole('button', { name: '打开' })
    expect(button.getAttribute('type')).toBe('button')
    expect(button.className).toBe('row-own')

    fireEvent.click(button)
    expect(clicks).toBe(1)
  })

  test('RowButton 显式 type=submit 时不被改回', () => {
    render(<RowButton type="submit">提交</RowButton>)

    expect(screen.getByRole('button', { name: '提交' }).getAttribute('type')).toBe('submit')
  })
})
