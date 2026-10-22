import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { FileContent } from '../../contract'
import type { FileOpener } from '../opener'
import { FileView } from '../viewer'

afterEach(cleanup)

const opener: FileOpener = { openListed: () => undefined, openReference: () => undefined }

function textOf(path: string, text: string): FileContent {
  return { kind: 'text', path, size: text.length, mtimeMs: 1, text, encoding: 'utf-8', truncated: false }
}

function show(path: string, text: string) {
  const api = {
    read: async () => textOf(path, text),
    onChanged: () => ({ dispose: () => undefined }),
  }
  return render(
    <FileView api={api} opener={opener} owner="t1" reveal={undefined} tab={{ id: 'f1', workspaceId: 'w1', path }} />,
  )
}

const LONG = `const value = '${'x'.repeat(400)}'\nnext()\n`

describe('文件查看器', () => {
  test('工具条只管怎么看与重读：没有复制路径、在资源管理器中显示、用默认应用打开', async () => {
    const view = show('src/a.ts', LONG)
    await view.findByText('next()')
    const names = view.getAllByRole('button').map((button) => button.getAttribute('aria-label') ?? button.textContent)
    expect(names).toEqual(['自动换行', '重新读取'])
  })

  test('自动换行：打开后行带随滚动口宽（祖先不再是 max-content），正文按空白折行', async () => {
    const view = show('src/a.ts', LONG)
    await view.findByText('next()')
    const region = view.getByRole('region', { name: '文件内容' })
    const band = region.firstElementChild
    const code = () => region.querySelector('.diff-line__code')
    expect(band?.className).toContain('w-max')
    expect(code()?.className).toContain('whitespace-pre')
    expect(code()?.className).not.toContain('whitespace-pre-wrap')

    fireEvent.click(view.getByRole('button', { name: '自动换行' }))
    expect(view.getByRole('button', { name: '自动换行' }).getAttribute('aria-pressed')).toBe('true')
    expect(region.firstElementChild?.className).not.toContain('w-max')
    expect(code()?.className).toContain('whitespace-pre-wrap')
  })

  test('Markdown：Preview / Source 是与技能文档同一个开关，默认 Preview；切到 Source 才有自动换行', async () => {
    const view = show('docs/readme.md', '# 标题\n\n正文一段。\n')
    const modes = await view.findByRole('group', { name: '查看方式' })
    const preview = view.getByRole('button', { name: 'Preview' })
    const source = view.getByRole('button', { name: 'Source' })
    expect(modes.className).toContain('view-switch')
    expect(preview.getAttribute('aria-pressed')).toBe('true')
    expect(view.queryByRole('button', { name: '自动换行' })).toBeNull()

    fireEvent.click(source)
    expect(source.getAttribute('aria-pressed')).toBe('true')
    expect(preview.getAttribute('aria-pressed')).toBe('false')
    await waitFor(() => {
      expect(view.getByRole('region', { name: '文件内容' }).textContent).toContain('# 标题')
    })
    expect(view.getByRole('button', { name: '自动换行' })).toBeDefined()
  })
})
