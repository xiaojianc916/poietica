import { describe, expect, test } from 'bun:test'
import { FileTabsStore } from '../tabs'

describe('FileTabsStore：按对话分账的文件标签', () => {
  test('打开去重并选中；同一个文件在不同对话里共用一个号', () => {
    const tabs = new FileTabsStore()
    const a = tabs.open('t1', 'w1', 'src/a.ts')
    const b = tabs.open('t1', 'w1', 'src/b.ts')
    expect(tabs.open('t1', 'w1', 'src/a.ts')).toBe(a)
    expect(tabs.of('t1')).toEqual({ ids: [a, b], activeId: a })
    expect(tabs.open('t2', 'w1', 'src/a.ts')).toBe(a)
    expect(tabs.of('t2')).toEqual({ ids: [a], activeId: a })
    expect(tabs.tab(a)).toEqual({ id: a, workspaceId: 'w1', path: 'src/a.ts' })
    /* 号进 DOM id：不带路径里的空格与斜杠 */
    expect(a).toMatch(/^file-\d+$/u)
  })

  test('不同工作区的同名路径是两个文件', () => {
    const tabs = new FileTabsStore()
    expect(tabs.open('t1', 'w1', 'a.ts')).not.toBe(tabs.open('t1', 'w2', 'a.ts'))
  })

  test('快照引用随变更才换（可作 useSyncExternalStore 的快照）；select 已选中的不发通知', () => {
    const tabs = new FileTabsStore()
    let emitted = 0
    tabs.subscribe(() => {
      emitted += 1
    })
    const a = tabs.open('t1', 'w1', 'a.ts')
    const snapshot = tabs.of('t1')
    expect(tabs.of('t1')).toBe(snapshot)
    tabs.select('t1', a)
    expect(emitted).toBe(1)
    expect(tabs.of(null)).toBeNull()
  })

  test('关掉选中的那个：选中落到剩下的最后一个；交回还剩几个；最后一个关掉整份账删除', () => {
    const tabs = new FileTabsStore()
    const a = tabs.open('t1', 'w1', 'a.ts')
    const b = tabs.open('t1', 'w1', 'b.ts')
    const c = tabs.open('t1', 'w1', 'c.ts')
    tabs.select('t1', b)
    expect(tabs.close('t1', b)).toBe(2)
    expect(tabs.of('t1')).toEqual({ ids: [a, c], activeId: c })
    expect(tabs.close('t1', a)).toBe(1)
    expect(tabs.of('t1')?.activeId).toBe(c)
    expect(tabs.close('t1', c)).toBe(0)
    expect(tabs.of('t1')).toBeNull()
  })

  test('没有任何对话再引用的文件：号与记录一起删（两张表都不只增不减）', () => {
    const tabs = new FileTabsStore()
    const a = tabs.open('t1', 'w1', 'a.ts')
    tabs.open('t2', 'w1', 'a.ts')
    tabs.close('t1', a)
    expect(tabs.tab(a)).toBeDefined()
    tabs.close('t2', a)
    expect(tabs.tab(a)).toBeUndefined()
    expect(tabs.workspaceIds().size).toBe(0)
    /* 再开同一个文件拿到新号 */
    expect(tabs.open('t1', 'w1', 'a.ts')).not.toBe(a)
  })

  test('带行号打开记一次「滚到这一行」，每次打开 seq 都变；关标签时一并清掉', () => {
    const tabs = new FileTabsStore()
    const a = tabs.open('t1', 'w1', 'a.ts', 12, 3)
    const first = tabs.revealOf('t1', a)
    expect(first).toMatchObject({ line: 12, column: 3 })
    tabs.open('t1', 'w1', 'a.ts', 12, 3)
    expect(tabs.revealOf('t1', a)?.seq).not.toBe(first?.seq)
    expect(tabs.revealOf('t2', a)).toBeUndefined()
    tabs.close('t1', a)
    expect(tabs.revealOf('t1', a)).toBeUndefined()
  })

  test('retain 只留布局还记得的归属；forgetWorkspace 关掉所有归属里属于它的标签', () => {
    const tabs = new FileTabsStore()
    tabs.open('t1', 'w1', 'a.ts')
    const b = tabs.open('t2', 'w2', 'b.ts')
    tabs.open('t3', 'w1', 'c.ts')
    tabs.retain(new Set(['t2', 't3']))
    expect(tabs.of('t1')).toBeNull()
    expect([...tabs.workspaceIds()].sort()).toEqual(['w1', 'w2'])
    tabs.forgetWorkspace('w1')
    expect(tabs.of('t3')).toBeNull()
    expect(tabs.of('t2')?.ids).toEqual([b])
    expect([...tabs.workspaceIds()]).toEqual(['w2'])
  })
})
