import { describe, expect, test } from 'bun:test'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AppError, Logger } from '@poietica/foundation'
import { openDatabase, runMigrations } from '@poietica/storage-sqlite'
import { createTestLogger, tempDir } from '@poietica/test-kit'
import { migrations } from '../migrations'
import { createTurnRewind, type TurnRewind } from '../rewind'
import { createTurnFileLedger, type TurnFileFact } from '../turn-files'
import { createTurnFilesRepository, type TurnFilesRepository } from '../turn-files-repository'

/*
 * 一轮文件改动的账本与撤销。
 *
 * 事实源是 conversation 的 turnFileChanged（引擎在写盘那一刻报出写前写后的正文）；这里用真的
 * SQLite（内存库）与真实临时目录里的文件，只把「线程 → 工作区 → 目录」那一跳做成假的 ——
 * 那正是 ledger 的输入。
 */

interface Bench {
  readonly root: string
  readonly rewind: TurnRewind
  readonly repo: TurnFilesRepository
  readonly changed: string[]
  readonly warns: string[]
  record(fact: Omit<TurnFileFact, 'threadId'> & { threadId?: string }): void
  dispose(): Promise<void>
}

async function bench(opts: { readonly threads?: Readonly<Record<string, string | null>> } = {}): Promise<Bench> {
  const dir = await tempDir('review-turn-files-')
  const db = openDatabase(':memory:')
  runMigrations(db, [{ moduleId: 'review', migrations }])
  const repo = createTurnFilesRepository(db.forModule('review'))
  const changed: string[] = []
  const rewind = createTurnRewind({
    repo,
    logger: createTestLogger(),
    emitChanged: (threadId) => {
      changed.push(threadId)
    },
    now: () => 1_700_000_000_000,
  })
  const threadWorkspace: Readonly<Record<string, string | null>> = opts.threads ?? {}
  const warns: string[] = []
  const base = createTestLogger()
  const logger: Logger = {
    ...base,
    warn: (message, fields) => {
      warns.push(message)
      base.warn(message, fields)
    },
  }
  const ledger = createTurnFileLedger({
    rewind,
    logger,
    workspaceIdOf: (threadId) => (threadId in threadWorkspace ? (threadWorkspace[threadId] ?? null) : 'w1'),
    pathOf: (workspaceId) => {
      if (workspaceId !== 'w1') throw new Error(`未知工作区：${workspaceId}`)
      return dir.path
    },
  })
  return {
    root: dir.path,
    rewind,
    repo,
    changed,
    warns,
    record: (fact) => ledger.record({ threadId: 't1', ...fact }),
    async dispose() {
      db.close()
      await dir.dispose()
    },
  }
}

async function put(file: string, text: string | null): Promise<void> {
  if (text === null) {
    await fs.rm(file, { force: true })
    return
  }
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, text, 'utf8')
}

async function read(file: string): Promise<string | null> {
  return await fs.readFile(file, 'utf8').catch(() => null)
}

async function errorOf(promise: Promise<unknown>): Promise<AppError> {
  return await promise.then(
    () => {
      throw new Error('这一步本该失败')
    },
    (error: unknown) => error as AppError,
  )
}

describe('review 一轮文件改动的账本', () => {
  test('多轮多文件：turns 升序，每轮报文件数、总加减行与文件清单（相对路径、正斜杠）', async () => {
    const b = await bench()
    b.record({ turn: 2, path: 'b.txt', before: 'x\n', after: 'x\ny\n' })
    b.record({ turn: 1, path: path.join('src', 'a.ts'), before: null, after: 'one\ntwo\n' })
    b.record({ turn: 2, path: 'c.txt', before: null, after: 'c\n' })

    const { turns } = b.rewind.list('t1', b.root)
    expect(turns.map((t) => t.turn)).toEqual([1, 2])
    expect(turns[0]).toMatchObject({ fileCount: 1, added: 2, removed: 0, reverted: false })
    expect(turns[0]?.files).toEqual([{ path: 'src/a.ts', added: 2, removed: 0 }])
    expect(turns[1]).toMatchObject({ fileCount: 2, added: 2, removed: 0, reverted: false })
    expect(turns[1]?.files).toEqual([
      { path: 'b.txt', added: 1, removed: 0 },
      { path: 'c.txt', added: 1, removed: 0 },
    ])
    await b.dispose()
  })

  test('path 落账时按工作区根解析成绝对路径，读出来转回相对、正斜杠', async () => {
    const b = await bench()
    b.record({ turn: 1, path: path.join('src', 'deep.ts'), before: null, after: 'x\n' })
    const { turns } = b.rewind.list('t1', b.root)
    expect(turns[0]?.files[0]?.path).toBe('src/deep.ts')
    await b.dispose()
  })

  test('同一轮同一文件写两次：保留最初的 before，after 取最新，行数按最初→最终算', async () => {
    const b = await bench()
    const file = path.join(b.root, 'a.txt')
    b.record({ turn: 1, path: 'a.txt', before: 'one\n', after: 'one\ntwo\n' })
    b.record({ turn: 1, path: 'a.txt', before: 'one\ntwo\n', after: 'one\ntwo\nthree\n' })
    b.record({ turn: 1, path: 'a.txt', before: 'one\ntwo\nthree\n', after: 'one\nTWO\nthree\n' })

    const { turns } = b.rewind.list('t1', b.root)
    expect(turns).toHaveLength(1)
    /* 最初 before（one）→ 最终 after（one/TWO/three）：多的两行就是这一轮真正加的行 */
    expect(turns[0]?.files).toEqual([{ path: 'a.txt', added: 2, removed: 0 }])

    /* 撤销写回的是最初那一份：这一轮开始之前文件里只有 one */
    await put(file, 'one\nTWO\nthree\n')
    await b.rewind.apply('t1', 1, b.root)
    expect(await read(file)).toBe('one\n')
    await b.dispose()
  })

  test('同一轮改的是已有内容：改一行报一加一减（按最初 before → 最终 after 算）', async () => {
    const b = await bench()
    b.record({ turn: 1, path: 'a.txt', before: 'one\ntwo\nthree\n', after: 'one\ntwo\nthree\nfour\n' })
    b.record({ turn: 1, path: 'a.txt', before: 'one\ntwo\nthree\nfour\n', after: 'one\nTWO\nthree\nfour\n' })
    const { turns } = b.rewind.list('t1', b.root)
    expect(turns[0]?.files).toEqual([{ path: 'a.txt', added: 2, removed: 1 }])
    expect(turns[0]).toMatchObject({ added: 2, removed: 1 })
    await b.dispose()
  })

  test('同一条事实重复灌进来：账不变，但每次落账都发一条通知（界面重读一次就对得上）', async () => {
    const b = await bench()
    const fact = { turn: 1, path: 'a.txt', before: null, after: 'x\n' }
    b.record(fact)
    b.record(fact)
    expect(b.rewind.list('t1', b.root).turns[0]?.files).toEqual([{ path: 'a.txt', added: 1, removed: 0 }])
    expect(b.changed).toEqual(['t1', 't1'])
    await b.dispose()
  })

  test('落账与撤销之后各发一条通知', async () => {
    const b = await bench()
    await put(path.join(b.root, 'a.txt'), 'a\n')
    b.record({ turn: 1, path: 'a.txt', before: null, after: 'a\n' })
    expect(b.changed).toEqual(['t1'])
    await b.rewind.apply('t1', 1, b.root)
    expect(b.changed).toEqual(['t1', 't1'])
    await b.dispose()
  })
})

describe('review 落账：线程 / 工作区已经没了', () => {
  test('线程已删（get 回 null）：丢弃这一笔并记一条 warn，不抛', async () => {
    const b = await bench({ threads: { t1: null } })
    b.record({ turn: 1, path: 'a.txt', before: null, after: 'a\n' })
    expect(b.rewind.list('t1', b.root).turns).toEqual([])
    expect(b.warns).toEqual(['turn file change for a removed thread'])
    await b.dispose()
  })

  test('工作区目录已经不可用：同样丢弃并 warn，不抛', async () => {
    const b = await bench({ threads: { t1: 'gone' } })
    b.record({ turn: 1, path: 'a.txt', before: null, after: 'a\n' })
    expect(b.rewind.list('t1', b.root).turns).toEqual([])
    expect(b.warns).toEqual(['turn file change for an unusable workspace'])
    await b.dispose()
  })
})

describe('review 撤销一轮：安全判据', () => {
  test('文件被外面改过 → unsafe 的 externally_modified，canApply=false；apply 整轮拒绝且一个文件都不动', async () => {
    const b = await bench()
    await put(path.join(b.root, 'a.txt'), 'after\n')
    await put(path.join(b.root, 'b.txt'), 'b\n')
    b.record({ turn: 1, path: 'a.txt', before: 'before\n', after: 'after\n' })
    b.record({ turn: 1, path: 'b.txt', before: null, after: 'b\n' })
    await put(path.join(b.root, 'a.txt'), '别人写的\n')

    const preview = await b.rewind.preview('t1', 1, b.root)
    expect(preview.canApply).toBe(false)
    expect(preview.unsafe).toEqual([{ path: 'a.txt', reason: 'externally_modified' }])
    expect(preview.safe).toEqual([{ path: 'b.txt' }])

    const error = await errorOf(b.rewind.apply('t1', 1, b.root))
    expect(error.code).toBe('review.rewind_unsafe')
    /* 不做部分写回：安全的那一份也不动 */
    expect(await read(path.join(b.root, 'b.txt'))).toBe('b\n')
    expect(await read(path.join(b.root, 'a.txt'))).toBe('别人写的\n')
    await b.dispose()
  })

  test('账本说这一轮写过它、盘上却不在 → unsafe 的 missing', async () => {
    const b = await bench()
    b.record({ turn: 1, path: 'a.txt', before: null, after: 'x\n' })
    const preview = await b.rewind.preview('t1', 1, b.root)
    expect(preview.unsafe).toEqual([{ path: 'a.txt', reason: 'missing' }])
    await b.dispose()
  })

  test('这一轮把它删了（after=null）：盘上仍不在 = 安全；又被别人建回来 = 不安全', async () => {
    const b = await bench()
    b.record({ turn: 1, path: 'a.txt', before: 'gone\n', after: null })
    expect((await b.rewind.preview('t1', 1, b.root)).canApply).toBe(true)
    await put(path.join(b.root, 'a.txt'), '又回来了\n')
    const preview = await b.rewind.preview('t1', 1, b.root)
    expect(preview.unsafe).toEqual([{ path: 'a.txt', reason: 'externally_modified' }])
    await b.dispose()
  })
})

describe('review 撤销一轮：写回与状态', () => {
  test('before=null 的新建文件：撤销就是删掉', async () => {
    const b = await bench()
    await put(path.join(b.root, 'deep', 'new.txt'), 'hello\n')
    b.record({ turn: 1, path: path.join('deep', 'new.txt'), before: null, after: 'hello\n' })
    expect(await b.rewind.apply('t1', 1, b.root)).toEqual({ turn: 1, reverted: true })
    expect(await read(path.join(b.root, 'deep', 'new.txt'))).toBeNull()
    await b.dispose()
  })

  test('after=null 的删除：撤销就是把 before 写回来（中间目录一并补上）', async () => {
    const b = await bench()
    b.record({ turn: 1, path: path.join('deep', 'gone.txt'), before: 'back\n', after: null })
    await b.rewind.apply('t1', 1, b.root)
    expect(await read(path.join(b.root, 'deep', 'gone.txt'))).toBe('back\n')
    await b.dispose()
  })

  test('撤销后该轮 reverted=true、行数仍报原值；再撤销一次 → rewind_not_available', async () => {
    const b = await bench()
    await put(path.join(b.root, 'a.txt'), 'x\ny\n')
    b.record({ turn: 1, path: 'a.txt', before: 'x\n', after: 'x\ny\n' })
    await b.rewind.apply('t1', 1, b.root)

    const { turns } = b.rewind.list('t1', b.root)
    expect(turns[0]).toMatchObject({ reverted: true, added: 1, removed: 0, fileCount: 1 })
    expect((await errorOf(b.rewind.apply('t1', 1, b.root))).code).toBe('review.rewind_not_available')
    expect((await errorOf(b.rewind.preview('t1', 1, b.root))).code).toBe('review.rewind_not_available')
    await b.dispose()
  })

  test('没有账的轮：preview / apply 都报 rewind_not_available', async () => {
    const b = await bench()
    expect((await errorOf(b.rewind.preview('t1', 9, b.root))).code).toBe('review.rewind_not_available')
    expect((await errorOf(b.rewind.apply('t1', 9, b.root))).code).toBe('review.rewind_not_available')
    await b.dispose()
  })

  test('只退这一轮：别的轮的账与文件都不动', async () => {
    const b = await bench()
    await put(path.join(b.root, 'one.txt'), 'one-after\n')
    await put(path.join(b.root, 'two.txt'), 'two-after\n')
    b.record({ turn: 1, path: 'one.txt', before: 'one-before\n', after: 'one-after\n' })
    b.record({ turn: 2, path: 'two.txt', before: 'two-before\n', after: 'two-after\n' })

    await b.rewind.apply('t1', 1, b.root)
    expect(await read(path.join(b.root, 'one.txt'))).toBe('one-before\n')
    expect(await read(path.join(b.root, 'two.txt'))).toBe('two-after\n')
    expect(b.rewind.list('t1', b.root).turns.map((t) => t.reverted)).toEqual([true, false])
    await b.dispose()
  })

  test('两条线程各记各的账；线程删了账一起清掉', async () => {
    const b = await bench()
    b.record({ turn: 1, path: 'a.txt', before: null, after: 'a\n' })
    b.rewind.record({ threadId: 't2', turn: 1, workspaceRoot: b.root, path: 'b.txt', before: null, after: 'b\n' })
    expect(b.rewind.list('t1', b.root).turns).toHaveLength(1)
    expect(b.rewind.list('t2', b.root).turns[0]?.files[0]?.path).toBe('b.txt')
    b.rewind.forgetThread('t1')
    expect(b.rewind.list('t1', b.root).turns).toEqual([])
    expect(b.rewind.list('t2', b.root).turns).toHaveLength(1)
    await b.dispose()
  })
})
