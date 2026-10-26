import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import type { FileContent } from '../../contract'
import type { FileOpener } from '../opener'
import { FileView } from '../viewer'

afterEach(cleanup)

const opener: FileOpener = {
  openDiff: () => undefined,
  openListed: () => undefined,
  openReference: () => undefined,
}

/* 账本那一格：正文两半都在 tab.diff 里，磁盘上是写完之后的样子（这里故意读不到）。 */
const diffTab = {
  id: 'file-1',
  workspaceId: 'w1',
  path: 'src/a.ts',
  diff: { before: 'one\ntwo\n', after: 'one\nTWO\n', turn: 2 },
}
const unreadable = {
  read: async () => {
    throw new Error('改动那一格不该读磁盘')
  },
  onChanged: () => ({ dispose: () => undefined }),
}

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

  test('自动换行：按下为开启，再按回关闭', async () => {
    const view = show('src/a.ts', LONG)
    await view.findByText('next()')
    expect(view.getByRole('button', { name: '自动换行' }).getAttribute('aria-pressed')).toBe('false')

    fireEvent.click(view.getByRole('button', { name: '自动换行' }))
    expect(view.getByRole('button', { name: '自动换行' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(view.getByRole('button', { name: '自动换行' }))
    expect(view.getByRole('button', { name: '自动换行' }).getAttribute('aria-pressed')).toBe('false')
  })

  test('Markdown：Preview / Source 是与技能文档同一个开关，默认 Preview；切到 Source 才有自动换行', async () => {
    const view = show('docs/readme.md', '# 标题\n\n正文一段。\n')
    await view.findByRole('group', { name: '查看方式' })
    const preview = view.getByRole('button', { name: 'Preview' })
    const source = view.getByRole('button', { name: 'Source' })
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

  test('改动那一格：画账本里的两半，不读磁盘', async () => {
    const view = render(<FileView api={unreadable} opener={opener} owner="t1" reveal={undefined} tab={diffTab} />)

    /* 着色是异步的（paint 交回后换一份上色版）：等它落定，免掉 act 警告。 */
    await waitFor(() => {
      expect(view.getByRole('region', { name: '文件改动' }).textContent).toContain('TWO')
    })
    const region = view.getByRole('region', { name: '文件改动' })
    /* 改前那一行与改后那一行都在行带里：两半都来自 tab.diff。 */
    expect(region.textContent).toContain('one')
    /* 标题那一条说明这是哪一轮的改动。 */
    expect(view.container.textContent).toContain('第 2 轮')
    /* 全文那一格才有的东西不该出现：这里没有「重新读取」（改动是账本里的事实，不是文件现况）。 */
    expect(view.queryByRole('button', { name: '重新读取' })).toBeNull()
  })
})
