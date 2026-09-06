import { describe, expect, it } from 'bun:test'

import { readToolLine, sayToolLine } from '../semantics/tool-intent'

/*
 * 卡片那一行。
 *
 * 类别与主语由投影定完，这里只钉三条：动词配文件名、没动词就转述主语、
 * 说不出来退回工具名。
 */

const CALL = { kind: 'execute', locations: [], subject: '', title: 'Bash' } as const

describe('工具调用那一行', () => {
  it('没有动词的类别直接转述主语', () => {
    expect(readToolLine({ ...CALL, subject: 'bun run typecheck' })).toBe('bun run typecheck')
  })

  it('只取第一行:多行命令在一行里画不下', () => {
    expect(readToolLine({ ...CALL, subject: 'cd packages\nls -la' })).toBe('cd packages')
  })

  it('太长的截断', () => {
    const line = readToolLine({ ...CALL, subject: 'a'.repeat(400) })

    expect(line.endsWith('…')).toBe(true)
    expect(line).toHaveLength(161)
  })

  it('文件类是动词加文件名,两种分隔符都切', () => {
    expect(
      readToolLine({
        kind: 'read',
        locations: [{ path: 'src/app.ts' }],
        subject: 'src/app.ts',
        title: 'Read',
      }),
    ).toBe('阅读 app.ts')
    expect(
      readToolLine({
        kind: 'write',
        locations: [{ path: 'C:\\repo\\a.ts' }],
        subject: 'C:\\repo\\a.ts',
        title: 'Write',
      }),
    ).toBe('写入 a.ts')
  })

  it('主语空着时动词自己成一句', () => {
    expect(readToolLine({ ...CALL, kind: 'todo', title: 'TodoList' })).toBe('更新任务清单')
  })

  it('什么都说不出来就退回工具名,审批那一层拿到的是 null', () => {
    expect(readToolLine({ ...CALL, subject: '   ' })).toBe('Bash')
    expect(sayToolLine({ ...CALL, subject: '   ' })).toBeNull()
  })
})
