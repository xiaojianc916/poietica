import { describe, expect, it } from 'bun:test'
import { ompToolView } from '../omp-tool-view'

describe('ompToolView', () => {
  it('bash 把命令画成 shell 围栏，产出画成文本', () => {
    const view = ompToolView(
      'bash',
      { command: 'bun test\nbun lint' },
      { content: [{ type: 'text', text: '42 pass' }] },
    )

    expect(view.subject).toBe('bun test')
    expect(view.request[0]).toEqual({
      type: 'command',
      command: 'bun test\nbun lint',
      language: 'bash',
    })
    expect(view.response[0]?.type).toBe('content')
  })

  it('read 的产出按扩展名上色', () => {
    const view = ompToolView(
      'read',
      { path: 'src/app.rs' },
      { content: [{ type: 'text', text: 'fn main() {}' }] },
    )

    expect(view.subject).toBe('src/app.rs')
    expect(view.response[0]?.type).toBe('command')
    expect(view.response[0]?.type === 'command' && view.response[0].language).toBe('rust')
  })

  it('edit 带新旧文本时给出结构化 diff', () => {
    const view = ompToolView(
      'edit',
      { path: 'a.ts', oldText: 'const a = 1', newText: 'const a = 2' },
      { content: [{ type: 'text', text: 'ok' }] },
    )

    expect(view.request[0]).toEqual({
      type: 'diff',
      path: 'a.ts',
      oldText: 'const a = 1',
      newText: 'const a = 2',
    })
  })

  it('grep 的主语是模式，不是路径', () => {
    const view = ompToolView('grep', { pattern: '未完成', path: 'src' }, { content: [] })

    expect(view.subject).toBe('未完成')
  })

  it('todo 的 init 画成勾选表', () => {
    const view = ompToolView(
      'todo',
      { op: 'init', items: ['a', 'b'] },
      { content: [{ type: 'text', text: 'ok' }] },
    )

    expect(view.request[0]?.type).toBe('todo')
    expect(view.request[0]?.type === 'todo' && view.request[0].items).toHaveLength(2)
  })

  it('browser 的产出把截图折成 markdown 图', () => {
    const view = ompToolView(
      'computer',
      { action: 'run', code: 'screenshot()' },
      {
        content: [
          { type: 'text', text: 'done' },
          { type: 'image', data: 'QUJD', mimeType: 'image/png' },
        ],
      },
    )

    expect(view.subject).toContain('run')
    const back = view.response[1]
    expect(back?.type).toBe('prose')
    expect(back?.type === 'prose' && back.text).toContain('data:image/png;base64,QUJD')
  })

  it('认不出的工具交回空两面，让抽屉走 JSON 兜底', () => {
    const view = ompToolView('mystery', { a: 1 }, { content: [{ type: 'text', text: 'x' }] })

    expect(view.request).toHaveLength(0)
    expect(view.response).toHaveLength(0)
  })

  it('失败的那句话优先于产出', () => {
    const view = ompToolView(
      'bash',
      { command: 'exit 1' },
      { content: [{ type: 'text', text: 'stdout' }] },
      'boom',
    )

    expect(view.response[0]?.type).toBe('content')
    expect(view.response[0]?.type === 'content' && view.response[0].content).toEqual({
      type: 'text',
      text: 'boom',
    })
  })
})
