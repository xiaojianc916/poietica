import fs from 'node:fs/promises'
import path from 'node:path'
import { computeFile } from '@poietica/design-system/diff'
import { AppError, invariant, type Logger } from '@poietica/foundation'
import type { TurnChanges, TurnChangesEntry, TurnRewindPreview } from '../contract'
import { reviewErrors } from '../contract/errors'
import type { TurnFileRow, TurnFilesRepository } from './turn-files-repository'

/**
 * 一轮文件改动的账与撤销。
 *
 * 账只从 conversation 的 turnFileChanged 来（引擎在写盘那一刻记下 before/after）：撤销一轮必须有
 * 写之前的正文，而写完之后工作区里只剩新内容。撤销只动工作区文件，**聊天历史一行不动** ——
 * 那一轮说过的话、做过的工具调用都还在时间线上。
 */

export interface TurnRewindDeps {
  readonly repo: TurnFilesRepository
  readonly logger: Logger
  /** 落账或撤销之后通知界面重读（对应 review.turnChangesChanged） */
  readonly emitChanged: (threadId: string) => void
  readonly now?: () => number
}

export interface TurnRewind {
  /** 落一笔账；工作区根用来把工具给的相对路径解析成绝对路径。 */
  record(fact: {
    readonly threadId: string
    readonly turn: number
    readonly workspaceRoot: string
    readonly path: string
    readonly before: string | null
    readonly after: string | null
  }): void
  /** 一条线程的全部轮次（升序）；workspaceRoot 用来把绝对路径转回界面显示的相对路径。 */
  list(threadId: string, workspaceRoot: string): TurnChanges
  preview(threadId: string, turn: number, workspaceRoot: string): Promise<TurnRewindPreview>
  /** 撤销一轮：有任何不安全就整轮拒绝，不做部分写回。 */
  apply(threadId: string, turn: number, workspaceRoot: string): Promise<{ turn: number; reverted: true }>
  forgetThread(threadId: string): void
}

/** 行数现算：全仓唯一的差分实现（design-system 的无头管线，不引 React）。 */
function statOf(before: string | null, after: string | null): { added: number; removed: number } {
  const stat = computeFile('', before ?? '', after ?? '').stat

  return { added: stat.added, removed: stat.removed }
}

/** 盘上的当前内容；文件不在（或读不成文本）返回 null。 */
async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** 界面显示用：相对工作区根、正斜杠（Win32 的文件 API 把 / 当分隔符，显示也统一）。 */
function displayPath(workspaceRoot: string, absolute: string): string {
  return path.relative(workspaceRoot, absolute).split(path.sep).join('/')
}

function notAvailable(threadId: string, turn: number): AppError {
  return new AppError(reviewErrors.rewind_not_available, '这一轮没有可以撤销的改动', { threadId, turn })
}

/** 一次撤销的一个落点：target 是这一轮之前那一份（null = 这一轮建的，撤销就是删掉）。 */
interface Restore {
  readonly path: string
  readonly target: string | null
  /** 撤销前盘上应该有的样子：写失败要按它回滚。 */
  readonly after: string | null
}

/**
 * 退回这一轮之前：target 为 null 就删掉（这一轮建的），否则写回 target（after 为 null 的删除也就此复原）。
 * 中间目录可能在这一轮里被一起删掉了，写回前先补上。
 *
 * 这一轮新建出来的目录不回收：删目录可能连带删掉别人刚放进去的东西，留一个空目录比删错东西便宜。
 */
async function restore(one: Restore): Promise<void> {
  if (one.target === null) {
    await fs.rm(one.path, { force: true })
    return
  }
  await fs.mkdir(path.dirname(one.path), { recursive: true })
  await fs.writeFile(one.path, one.target, 'utf8')
}

/** 写失败之后把动过的按各自的 after 放回去；回滚本身失败只记 warn，不盖掉原始错误。 */
async function rollback(done: readonly Restore[], logger: Logger): Promise<void> {
  for (const one of done) {
    try {
      if (one.after === null) {
        await fs.rm(one.path, { force: true })
        continue
      }
      await fs.writeFile(one.path, one.after, 'utf8')
    } catch (e) {
      logger.warn('turn rewind rollback failed', { path: one.path, error: String(e) })
    }
  }
}

type Obstacle = { path: string; reason: 'externally_modified' | 'missing' }

/**
 * 落盘之前再核对一遍（不只是 preview 那一次）：preview 与 apply 之间隔着一次 RPC 往返，这期间用户
 * 可能在编辑器里又改了文件。核不过就整轮拒绝 —— 撤一半比没撤更糟：界面报「已撤销」，工作区却是
 * 一半旧一半别人写的。
 */
async function verified(rows: readonly TurnFileRow[], workspaceRoot: string): Promise<Restore[]> {
  const targets: Restore[] = []
  const unsafe: Obstacle[] = []
  for (const row of rows) {
    const current = await readIfPresent(row.path)
    if (current !== row.after) {
      unsafe.push({
        path: displayPath(workspaceRoot, row.path),
        reason: current === null && row.after !== null ? 'missing' : 'externally_modified',
      })
      continue
    }
    targets.push({ path: row.path, target: row.before, after: row.after })
  }
  if (unsafe.length > 0) {
    throw new AppError(reviewErrors.rewind_unsafe, '这些文件在此期间被改过，不能撤销', { unsafe })
  }
  invariant(targets.length === rows.length, '核过的落点与账本行数对不上')

  return targets
}

/**
 * 文件系统没有事务：逐个写，写不动就把已经写好的按各自的 after 放回去，再报 rewind_unsafe ——
 * 账本一行都不翻，用户重试一次还是整轮撤。核对与落盘之间那一个很短的窗口（写入当口文件被别人改）
 * 挡不住，挡不住就回滚。
 */
async function restoreAll(targets: readonly Restore[], workspaceRoot: string, logger: Logger): Promise<void> {
  const done: Restore[] = []
  for (const one of targets) {
    try {
      await restore(one)
      done.push(one)
    } catch (e) {
      await rollback(done, logger)
      throw new AppError(reviewErrors.rewind_unsafe, '撤销时写文件失败，已经放回原样', {
        path: displayPath(workspaceRoot, one.path),
        error: String(e),
      })
    }
  }
}

export function createTurnRewind(d: TurnRewindDeps): TurnRewind {
  const now = d.now ?? Date.now

  const list = (threadId: string, workspaceRoot: string): TurnChanges => {
    const byTurn = new Map<number, TurnFileRow[]>()
    for (const row of d.repo.listByThread(threadId)) {
      const held = byTurn.get(row.turn)
      if (held === undefined) byTurn.set(row.turn, [row])
      else held.push(row)
    }
    const turns: TurnChangesEntry[] = []
    for (const [turn, rows] of [...byTurn].sort((a, b) => a[0] - b[0])) {
      let added = 0
      let removed = 0
      const files = rows.map((row) => {
        const stat = statOf(row.before, row.after)
        added += stat.added
        removed += stat.removed

        return { path: displayPath(workspaceRoot, row.path), added: stat.added, removed: stat.removed }
      })
      turns.push({
        turn,
        fileCount: files.length,
        added,
        removed,
        /* 撤销之后行数仍报原值（那一轮确实改过这么多），只有这一格翻成 true。 */
        reverted: rows.every((row) => row.state === 'reverted'),
        files,
      })
    }

    return { turns }
  }

  const preview = async (threadId: string, turn: number, workspaceRoot: string): Promise<TurnRewindPreview> => {
    const rows = d.repo.listByTurn(threadId, turn)
    if (rows.length === 0) throw notAvailable(threadId, turn)
    /* 已经撤销过的轮不能再撤一次：那一轮的 after 早已不在盘上，按内容比会全部报不安全，
     * 但真正的理由是「撤销过了」，说法要分开。 */
    if (rows.every((row) => row.state === 'reverted')) throw notAvailable(threadId, turn)

    const safe: { path: string }[] = []
    const unsafe: Obstacle[] = []
    for (const row of rows) {
      const current = await readIfPresent(row.path)
      const shown = displayPath(workspaceRoot, row.path)
      if (current === row.after) safe.push({ path: shown })
      else
        unsafe.push({ path: shown, reason: current === null && row.after !== null ? 'missing' : 'externally_modified' })
    }

    return { safe, unsafe, canApply: unsafe.length === 0 }
  }

  return {
    record(fact) {
      d.repo.upsert({
        threadId: fact.threadId,
        turn: fact.turn,
        /* 工具给的是 path / file_path 的原样值，可能是相对的：账本里一律存绝对路径，撤销时才写得回去。 */
        path: path.resolve(fact.workspaceRoot, fact.path),
        before: fact.before,
        after: fact.after,
        createdAt: now(),
      })
      d.emitChanged(fact.threadId)
    },

    list,
    preview,

    async apply(threadId, turn, workspaceRoot) {
      const rows = d.repo.listByTurn(threadId, turn)
      if (rows.length === 0 || rows.every((row) => row.state === 'reverted')) {
        throw notAvailable(threadId, turn)
      }
      const targets = await verified(rows, workspaceRoot)
      await restoreAll(targets, workspaceRoot, d.logger)
      d.repo.markReverted(threadId, turn)
      d.emitChanged(threadId)

      return { turn, reverted: true }
    },

    forgetThread(threadId) {
      d.repo.removeThread(threadId)
    },
  }
}
