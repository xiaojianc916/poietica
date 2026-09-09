import { describe, expect, test } from 'bun:test'
import type { LibraryEntry, LibraryReply, LibraryRequest } from '@poietica/contract/library'
import { LibraryController, type LibraryGateway } from './controller'
import { setCell } from './sheet'

function entry(path: string, folder: boolean): LibraryEntry {
  const cut = path.lastIndexOf('/')

  return {
    path,
    name: cut < 0 ? path : path.slice(cut + 1),
    parent: cut < 0 ? '' : path.slice(0, cut),
    format: folder ? null : 'markdown',
    modified: null,
    bytes: '0',
  }
}

function recorder(
  entries: readonly LibraryEntry[],
  answer: (request: LibraryRequest) => LibraryReply,
): { gateway: LibraryGateway; sent: LibraryRequest[] } {
  const sent: LibraryRequest[] = []

  return {
    sent,
    gateway: {
      execute: (request) => {
        sent.push(request)

        return Promise.resolve(
          request.kind === 'list'
            ? { kind: 'catalog', value: { entries: [...entries] } }
            : answer(request),
        )
      },
      importFile: () => Promise.resolve(null),
    },
  }
}

const DOCUMENT: LibraryReply = {
  kind: 'document',
  value: { path: '未命名文档.md', version: 'v1', body: { kind: 'markdown', value: '' } },
}

describe('LibraryController', () => {
  test('新建落在谁家由界面说了算', async () => {
    const { gateway, sent } = recorder([entry('随笔', true)], (request) =>
      request.kind === 'create' ? { kind: 'placed', value: '随笔/未命名文档.md' } : DOCUMENT,
    )
    const library = new LibraryController(gateway, String)

    await library.start()
    await library.create('随笔', 'markdown')

    expect(sent.find((request) => request.kind === 'create')).toEqual({
      kind: 'create',
      parent: '随笔',
      format: 'markdown',
    })
  })

  test('连点两次新建得到两份，请求不被丢掉', async () => {
    let made = 0
    const { gateway } = recorder([], (request) => {
      if (request.kind === 'create') {
        made += 1

        return { kind: 'placed', value: '未命名文档.md' }
      }

      return DOCUMENT
    })
    const library = new LibraryController(gateway, String)

    await Promise.all([library.create('', 'markdown'), library.create('', 'markdown')])

    expect(made).toBe(2)
  })

  test('保存失败保留草稿并报告原因', async () => {
    const { gateway } = recorder([entry('甲.md', false)], (request) => {
      if (request.kind === 'save') {
        throw new Error('已被改动')
      }

      return {
        kind: 'document',
        value: { path: '甲.md', version: 'v1', body: { kind: 'markdown', value: '原文' } },
      }
    })
    const library = new LibraryController(gateway, String)

    await library.open('甲.md')
    library.editText('改过的')

    await library.save()

    expect(library.getSnapshot().draft).toEqual({ kind: 'markdown', value: '改过的' })
    expect(library.getSnapshot().failure).not.toBeNull()
  })

  test('切换资料前先把草稿落盘', async () => {
    const { gateway, sent } = recorder(
      [entry('甲.md', false), entry('乙.md', false)],
      (request) => ({
        kind: 'document',
        value: {
          path: request.kind === 'read' ? request.path : '甲.md',
          version: 'v1',
          body: { kind: 'markdown', value: '原文' },
        },
      }),
    )
    const library = new LibraryController(gateway, String)

    await library.open('甲.md')
    library.editText('改过的')

    await library.open('乙.md')

    expect(sent.filter((request) => request.kind === 'save')).toHaveLength(1)
    expect(library.getSnapshot().document?.path).toBe('乙.md')
  })

  test('表格改动进撤销栈，保存只报版本号', async () => {
    const sheet = { header: ['甲'], rows: [['一']] }
    const { gateway, sent } = recorder([entry('表.csv', false)], (request) => ({
      kind: 'document',
      value: {
        path: '表.csv',
        version: request.kind === 'save' ? 'v2' : 'v1',
        body: { kind: 'table', value: sheet },
      },
    }))
    const library = new LibraryController(gateway, String)

    await library.open('表.csv')
    library.revise((current) => setCell(current, 0, 0, '二'), 'cell:0:0')
    library.revise((current) => setCell(current, 0, 0, '三'), 'cell:0:0')
    library.undo()

    expect(library.getSnapshot().draft).toEqual({ kind: 'table', value: sheet })

    library.redo()

    await library.save()

    expect(sent.find((request) => request.kind === 'save')).toEqual({
      kind: 'save',
      path: '表.csv',
      expected: 'v1',
      body: { kind: 'table', value: { header: ['甲'], rows: [['三']] } },
    })
  })
})
