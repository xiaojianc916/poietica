import { describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { McpEntry } from '../mcp-config'
import { McpFormPage } from '../mcp-settings'

/*
 * 新建 MCP 服务器的表单：名称按 omp 的判据在本地判，错误贴在那一格旁边而不是页面底部；
 * 名称不合法时保存键置灰。happy-dom 里 label 包住 input 的关联不稳，按 placeholder 定位。
 */

const NAME_RULE = '名称只能包含字母、数字、连字符、下划线、点与冒号；词之间只允许一个空格。'

function draw(onUpsert: (entry: McpEntry) => Promise<void> = async () => undefined): void {
  render(<McpFormPage busy={false} failure={null} onClose={() => undefined} onUpsert={onUpsert} />)
}

function fill(placeholder: string, value: string): void {
  fireEvent.change(screen.getByPlaceholderText(placeholder), { target: { value } })
}

describe('新建 MCP 服务器的表单', () => {
  test('名称带斜杠：保存键置灰，红字贴在名称那一格，且不在底部重复一遍', () => {
    draw()

    fill('my-mcp-server', 'a/b')
    fill('npx', 'npx')

    expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(NAME_RULE)).not.toBeNull()
    expect(screen.getByPlaceholderText('my-mcp-server').getAttribute('aria-invalid')).toBe('true')
    /* 只有字段旁这一处：同一句话不在底部再重复一遍。 */
    expect(screen.getAllByText(NAME_RULE)).toHaveLength(1)

    cleanup()
  })

  test('名称清空：不报错（还没开始填），保存键仍置灰', () => {
    draw()

    fill('npx', 'npx')

    expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByText(NAME_RULE)).toBeNull()

    cleanup()
  })

  test('名称与命令都填好：可以保存，交出去的正文里没有死键，超时落在 timeout', async () => {
    const entries: McpEntry[] = []
    draw(async (entry) => {
      entries.push(entry)
    })

    fill('my-mcp-server', 'demo')
    fill('npx', 'npx')
    fill('30000', '0')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await Bun.sleep(0)

    expect(entries).toHaveLength(1)
    expect(entries[0]?.config).toEqual({ args: [], command: 'npx', timeout: 0 })

    cleanup()
  })

  test('名称合法但命令留空：保存键置灰', () => {
    draw()

    fill('my-mcp-server', 'demo')

    expect(screen.getByRole('button', { name: '保存' }).hasAttribute('disabled')).toBe(true)

    cleanup()
  })
})
