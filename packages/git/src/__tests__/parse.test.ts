import { describe, expect, test } from 'bun:test'
import { parseForEachRef, parseNameStatus, parseNulList, parseNumstat, parsePorcelainV2, toChangeLists } from '../parse'

const rec = (...lines: string[]): string => `${lines.join('\0')}\0`

describe('parsePorcelainV2', () => {
  test('头部：oid、head、upstream、ahead/behind', () => {
    const status = parsePorcelainV2(
      rec('# branch.oid abc123', '# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1'),
    )
    expect(status.oid).toBe('abc123')
    expect(status.head).toBe('main')
    expect(status.upstream).toBe('origin/main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(1)
  })

  test('(initial) → oid null；(detached) → head null', () => {
    const status = parsePorcelainV2(rec('# branch.oid (initial)', '# branch.head (detached)'))
    expect(status.oid).toBeNull()
    expect(status.head).toBeNull()
  })

  test('ordinary：路径含空格也能原样取出', () => {
    const status = parsePorcelainV2(rec('1 .M N... 100644 100644 100644 h1 h2 src/a b.ts'))
    expect(status.entries).toEqual([{ kind: 'ordinary', index: '.', worktree: 'M', path: 'src/a b.ts', oldPath: null }])
  })

  test('renamed：下一段是 oldPath，且后续条目不错位', () => {
    const status = parsePorcelainV2(rec('2 R. N... 100644 100644 100644 h1 h2 R100 new.ts', 'old.ts', '? later.txt'))
    expect(status.entries[0]).toEqual({
      kind: 'renamed',
      index: 'R',
      worktree: '.',
      path: 'new.ts',
      oldPath: 'old.ts',
    })
    expect(status.entries[1]?.path).toBe('later.txt')
  })

  test('unmerged：取第 10 个字段之后的路径', () => {
    const status = parsePorcelainV2(rec('u UU N... 100644 100644 100644 100644 h1 h2 h3 src/conflict.ts'))
    expect(status.entries[0]).toEqual({
      kind: 'unmerged',
      index: 'U',
      worktree: 'U',
      path: 'src/conflict.ts',
      oldPath: null,
    })
  })

  test('untracked：非 ASCII 路径不加引号', () => {
    const status = parsePorcelainV2(rec('? 文档/说明.md'))
    expect(status.entries[0]).toEqual({
      kind: 'untracked',
      index: '?',
      worktree: '?',
      path: '文档/说明.md',
      oldPath: null,
    })
  })
})

describe('toChangeLists', () => {
  test('MM 同时在两组；A. 只在已暂存；.D 只在未暂存；renamed 暂存项带 oldPath；! 被忽略', () => {
    const status = parsePorcelainV2(
      rec(
        '1 MM N... 100644 100644 100644 h1 h2 both.ts',
        '1 A. N... 100644 100644 100644 h1 h2 added.ts',
        '1 .D N... 100644 100644 100644 h1 h2 deleted.ts',
        '2 R. N... 100644 100644 100644 h1 h2 R100 new.ts',
        'old.ts',
        '! ignored.log',
      ),
    )
    const { staged, unstaged } = toChangeLists(status.entries)
    expect(staged.map((e) => [e.path, e.change, e.oldPath])).toEqual([
      ['both.ts', 'modified', null],
      ['added.ts', 'added', null],
      ['new.ts', 'renamed', 'old.ts'],
    ])
    expect(unstaged.map((e) => [e.path, e.change])).toEqual([
      ['both.ts', 'modified'],
      ['deleted.ts', 'deleted'],
    ])
  })

  test('unmerged → 未暂存 conflicted；untracked → 未暂存 untracked', () => {
    const status = parsePorcelainV2(rec('u UU N... 100644 100644 100644 100644 h1 h2 h3 c.ts', '? new.txt'))
    const { staged, unstaged } = toChangeLists(status.entries)
    expect(staged.length).toBe(0)
    expect(unstaged.map((e) => [e.path, e.change])).toEqual([
      ['c.ts', 'conflicted'],
      ['new.txt', 'untracked'],
    ])
  })
})

describe('parseNumstat', () => {
  test('普通、二进制、重命名三种记录', () => {
    const entries = parseNumstat('3\t4\tsrc/a.ts\0-\t-\tlogo.png\0')
    expect(entries).toEqual([
      { path: 'src/a.ts', oldPath: null, additions: 3, deletions: 4, binary: false },
      { path: 'logo.png', oldPath: null, additions: null, deletions: null, binary: true },
    ])
    const renamed = parseNumstat('1\t2\t\0old.ts\0new.ts\0')
    expect(renamed).toEqual([{ path: 'new.ts', oldPath: 'old.ts', additions: 1, deletions: 2, binary: false }])
  })
})

describe('parseNameStatus', () => {
  test('M 与 R087 两种记录', () => {
    expect(parseNameStatus('M\0src/a.ts\0')).toEqual([{ status: 'M', path: 'src/a.ts', oldPath: null, score: null }])
    expect(parseNameStatus('R087\0old.ts\0new.ts\0')).toEqual([
      { status: 'R', path: 'new.ts', oldPath: 'old.ts', score: 87 },
    ])
  })
})

describe('parseForEachRef', () => {
  test('当前分支、无 upstream、空日期', () => {
    const entries = parseForEachRef(
      ['main\u0000origin/main\u00001700000000\u0000*', 'feature\u0000\u0000\u0000 ', ''].join('\n'),
    )
    expect(entries[0]).toEqual({
      name: 'main',
      upstream: 'origin/main',
      lastCommitAt: 1_700_000_000_000,
      isCurrent: true,
    })
    expect(entries[1]).toEqual({ name: 'feature', upstream: null, lastCommitAt: null, isCurrent: false })
  })
})

describe('parseNulList', () => {
  test('去掉空段', () => {
    expect(parseNulList('a\0b\0\0')).toEqual(['a', 'b'])
  })
})
