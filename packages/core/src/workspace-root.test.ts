import { describe, expect, it } from 'bun:test'

import { normalizeWorkspaceRoot, workspaceRootName } from './workspace-root'

/*
 * 分组的一级索引就是这两个函数的返回值：身份错了，两个目录会并成一组，或者
 * 一个目录裂成两组。它们刚从 packages/workspace 搬到这里，而「搬家不改语义」
 * 这句话得由测试说了算，不能由注释说了算。
 */
describe('工作目录的身份', () => {
  it('同一个目录的几种写法落到同一个身份上', () => {
    const expected = 'D:/xiaojianc/poietica'

    expect(normalizeWorkspaceRoot('D:\\xiaojianc\\poietica')).toBe(expected)
    expect(normalizeWorkspaceRoot('d:/xiaojianc/poietica/')).toBe(expected)
    expect(normalizeWorkspaceRoot('  D:\\\\xiaojianc\\poietica\\  ')).toBe(expected)
  })

  it('平级的两个目录不会互相吞并', () => {
    expect(normalizeWorkspaceRoot('D:/a')).not.toBe(normalizeWorkspaceRoot('D:/a/b'))
  })

  it('根不会被结尾分隔符抹成空串', () => {
    expect(normalizeWorkspaceRoot('/')).toBe('/')
    expect(normalizeWorkspaceRoot('//')).toBe('/')
  })

  /* 盘符根今天落成 C: —— 搬家时逐字节保下来的行为，要改得单独一笔带测试。 */
  it('盘符根保持搬家前的写法', () => {
    expect(normalizeWorkspaceRoot('C:/')).toBe('C:')
  })
})

describe('工作目录的名字', () => {
  it('取路径的最后一段，结尾分隔符不算数', () => {
    expect(workspaceRootName('D:\\xiaojianc\\poietica')).toBe('poietica')
    expect(workspaceRootName('D:/xiaojianc/poietica/')).toBe('poietica')
  })

  it('根没有末段时，路径本身就是它的名字', () => {
    expect(workspaceRootName('/')).toBe('/')
  })
})
