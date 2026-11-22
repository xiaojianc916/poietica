import fs from 'node:fs/promises'
import path from 'node:path'
import { computeFile } from '@poietica/diff'
import type { Checkpoint } from '@poietica/feature-checkpoints/contract'
import {
  CHECKPOINT_TURN_END_LABEL,
  CHECKPOINT_TURN_START_LABEL,
  type CheckpointService,
} from '@poietica/feature-checkpoints/core-api'
import { AppError, invariant, type Logger, mapLimited } from '@poietica/foundation'
import type { TurnChanges, TurnChangesEntry, TurnFilePatch, TurnRewindPreview } from '../contract'
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
  /** 影子检查点；给了就让撤销以磁盘真实变化为准（覆盖 shell / 脚本写入）。 */
  readonly checkpoints?: CheckpointService
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
  list(threadId: string, workspaceRoot: string): Promise<TurnChanges>
  /**
   * 这一轮某文件改前改后的正文（右坞那一格 diff 的两半）。
   *
   * 账本有这一笔就交账本；只有检查点（shell / 脚本写入）时，从起止快照里各读一份。
   * 按**显示路径**找：界面手里的是相对路径（正斜杠），账本里存的是绝对路径。
   */
  patch(threadId: string, turn: number, workspaceRoot: string, shownPath: string): Promise<TurnFilePatch>
  preview(threadId: string, turn: number, workspaceRoot: string): Promise<TurnRewindPreview>
  /** 撤销一轮：有任何不安全就整轮拒绝，不做部分写回。 */
  apply(threadId: string, turn: number, workspaceRoot: string): Promise<{ turn: number; reverted: true }>
  forgetThread(threadId: string): void
}

/** 核对与回滚都只读/写互不相干的文件：限住同时打开的句柄数，别一次把整轮文件全放出去。 */
const FILE_CONCURRENCY = 8

/** 行数现算：全仓唯一的差分实现（diff 包的无头管线，不引 React）。 */
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

interface TurnCheckpoints {
  readonly start: Checkpoint
  readonly end: Checkpoint
}

/**
 * 找这一轮的起止快照。每一轮固定产生一条「轮次开始」与一条「轮次结束」，按 threadId 过滤后
 * 取第 turn 条即可；不按时间戳配对，避免同一秒内连续几轮时选错。
 */
async function turnCheckpoints(
  checkpoints: CheckpointService,
  threadId: string,
  workspaceRoot: string,
  turn: number,
  logger: Logger,
): Promise<TurnCheckpoints | null> {
  try {
    const all = await checkpoints.list(workspaceRoot, 2_000)
    const mine = all.filter((entry) => entry.threadId === threadId).reverse()
    const start = mine.filter((entry) => entry.label === CHECKPOINT_TURN_START_LABEL)[turn - 1]
    const end = mine.filter((entry) => entry.label === CHECKPOINT_TURN_END_LABEL)[turn - 1]
    return start !== undefined && end !== undefined ? { start, end } : null
  } catch (error) {
    logger.warn('checkpoint lookup failed', { threadId, error: String(error) })
    return null
  }
}

interface CheckpointPlan extends TurnCheckpoints {
  readonly paths: readonly string[]
}

/** 这一轮真实改过的路径；起止快照或 diff 拿不到就返回 null，调用方退回指标本。 */
async function checkpointPlan(
  checkpoints: CheckpointService,
  threadId: string,
  workspaceRoot: string,
  turn: number,
  logger: Logger,
): Promise<CheckpointPlan | null> {
  const found = await turnCheckpoints(checkpoints, threadId, workspaceRoot, turn, logger)
  if (found === null) return null
  try {
    const paths = await checkpoints.diffPaths({ workspaceRoot, from: found.start.id, to: found.end.id })
    return paths.length === 0 ? null : { ...found, paths }
  } catch (error) {
    logger.warn('checkpoint diff unavailable; falling back to ledger', {
      threadId,
      turn,
      error: String(error),
    })
    return null
  }
}

/**
 * 这一笔是不是二进制。git numstat 说了算（图片、压缩包给 `-`），与审查清单同一判据。
 * numstat 问不到就按文本处理（老行为）：正文可能带替换符，但总比空白强；记一条 warn。
 */
async function isBinaryPath(
  checkpoints: CheckpointService,
  workspaceRoot: string,
  plan: CheckpointPlan,
  path: string,
  logger: Logger,
): Promise<boolean> {
  try {
    const stats = await checkpoints.diffNumstat({ workspaceRoot, from: plan.start.id, to: plan.end.id })
    return stats.some((entry) => entry.path === path && entry.binary)
  } catch (error) {
    logger.warn('checkpoint numstat failed; treating patch as text', { path, error: String(error) })
    return false
  }
}

/**
 * 检查点里这一份的两半。二进制只留「在不在」（null = 不在，'' = 在）：
 * `git show` 把 PNG 的字节宽松解成 UTF-8，当正文交出去就是一屏替换符。
 */
async function checkpointPatch(
  checkpoints: CheckpointService,
  workspaceRoot: string,
  plan: CheckpointPlan,
  wanted: string,
  logger: Logger,
): Promise<TurnFilePatch> {
  const [before, after, binary] = await Promise.all([
    checkpoints.readFile({ workspaceRoot, checkpoint: plan.start.id, path: wanted }),
    checkpoints.readFile({ workspaceRoot, checkpoint: plan.end.id, path: wanted }),
    isBinaryPath(checkpoints, workspaceRoot, plan, wanted, logger),
  ])
  if (binary) {
    return { before: before === null ? null : '', after: after === null ? null : '', binary: true }
  }
  return { before, after, binary: false }
}

/** 从起点恢复；「结束」快照用来做三方核对。冲突统一翻成 review 侧的 rewind_unsafe。 */
async function restoreCheckpointPlan(
  checkpoints: CheckpointService,
  workspaceRoot: string,
  plan: CheckpointPlan,
): Promise<void> {
  try {
    await checkpoints.restore({
      workspaceRoot,
      checkpoint: plan.start.id,
      expect: plan.end.id,
      paths: [...plan.paths],
    })
  } catch (error) {
    if (error instanceof AppError && error.code === 'checkpoints.conflict') {
      throw new AppError(reviewErrors.rewind_unsafe, '这些文件在这一轮之后又被改过，不能撤销', {
        cause: error.message,
      })
    }
    throw error
  }
}

async function previewCheckpointPlan(
  checkpoints: CheckpointService,
  workspaceRoot: string,
  plan: CheckpointPlan,
): Promise<TurnRewindPreview> {
  const drift = new Set(await checkpoints.changedPaths({ workspaceRoot, checkpoint: plan.end.id }))
  const safe = plan.paths.filter((entry) => !drift.has(entry)).map((entry) => ({ path: entry }))
  const unsafe = plan.paths
    .filter((entry) => drift.has(entry))
    .map((entry) => ({ path: entry, reason: 'externally_modified' as const }))
  return { safe, unsafe, canApply: unsafe.length === 0 }
}

interface CheckpointTurnSummary {
  readonly files: readonly { readonly path: string; readonly added: number; readonly removed: number }[]
}

/**
 * 每条线程的检查点轮次摘要。检查点是唯一能看见 shell / 脚本写入的地方：这些轮没有工具账，
 * 但起止快照之间确实有 diff。轮次编号按 Start/End 两侧各自的顺序配对。
 */
async function checkpointSummaries(
  checkpoints: CheckpointService,
  threadId: string,
  workspaceRoot: string,
  logger: Logger,
  haveLedger: ReadonlySet<number>,
): Promise<Map<number, CheckpointTurnSummary>> {
  const summaries = new Map<number, CheckpointTurnSummary>()
  try {
    const all = await checkpoints.list(workspaceRoot, 2_000)
    const mine = all.filter((entry) => entry.threadId === threadId).reverse()
    const starts = mine.filter((entry) => entry.label === CHECKPOINT_TURN_START_LABEL)
    const ends = mine.filter((entry) => entry.label === CHECKPOINT_TURN_END_LABEL)
    const count = Math.min(starts.length, ends.length)
    for (let index = 0; index < count; index++) {
      /* 有工具账的轮直接用账本（不必为每一轮起一次 git）；检查点只补「一行账都没有」的轮。 */
      if (haveLedger.has(index + 1)) continue
      const start = starts[index]
      const end = ends[index]
      if (start === undefined || end === undefined) continue
      try {
        /* 逐轮取 diff：都打在同一份 git 对象库上，串行既避开锁竞争，也把并发 git 进程数压在 1。
           只有「一行账都没有」的轮才走到这里，轮数上限是 2000 条检查点，不是每轮都起一次 git。 */
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const files = await checkpoints.diffNumstat({ workspaceRoot, from: start.id, to: end.id })
        if (files.length > 0) summaries.set(index + 1, { files })
      } catch (error) {
        logger.warn('checkpoint numstat failed', { threadId, turn: index + 1, error: String(error) })
      }
    }
  } catch (error) {
    logger.warn('checkpoint turn list failed', { threadId, error: String(error) })
  }
  return summaries
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
  /* 各文件路径互不重叠：并发回滚；单个失败只记 warn，不挡其余。 */
  await mapLimited(done, FILE_CONCURRENCY, async (one) => {
    try {
      if (one.after === null) {
        await fs.rm(one.path, { force: true })
        return
      }
      await fs.writeFile(one.path, one.after, 'utf8')
    } catch (e) {
      logger.warn('turn rewind rollback failed', { path: one.path, error: String(e) })
    }
  })
}

type Obstacle = { path: string; reason: 'externally_modified' | 'missing' }

/** 指标本的核对：手里只有工具写账的 before/after，按盘上当前内容逐格比。 */
async function ledgerPreview(rows: readonly TurnFileRow[], workspaceRoot: string): Promise<TurnRewindPreview> {
  const safe: { path: string }[] = []
  const unsafe: Obstacle[] = []
  /* 只读核对彼此独立；结果按账本行序收回，safe / unsafe 顺序才稳定。 */
  const checked = await mapLimited(rows, FILE_CONCURRENCY, async (row) => ({
    row,
    current: await readIfPresent(row.path),
  }))
  for (const { row, current } of checked) {
    const shown = displayPath(workspaceRoot, row.path)
    if (current === row.after) safe.push({ path: shown })
    else
      unsafe.push({ path: shown, reason: current === null && row.after !== null ? 'missing' : 'externally_modified' })
  }
  return { safe, unsafe, canApply: unsafe.length === 0 }
}

/**
 * 落盘之前再核对一遍（不只是 preview 那一次）：preview 与 apply 之间隔着一次 RPC 往返，这期间用户
 * 可能在编辑器里又改了文件。核不过就整轮拒绝 —— 撤一半比没撤更糟：界面报「已撤销」，工作区却是
 * 一半旧一半别人写的。
 */
async function verified(rows: readonly TurnFileRow[], workspaceRoot: string): Promise<Restore[]> {
  /* 只读核对彼此独立；结果按账本行序收回，unsafe 的清单顺序才稳定。 */
  const checked = await mapLimited(rows, FILE_CONCURRENCY, async (row) => ({
    row,
    current: await readIfPresent(row.path),
  }))
  const targets: Restore[] = []
  const unsafe: Obstacle[] = []
  for (const { row, current } of checked) {
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
  /*
   * 文件系统没有事务：逐个写是刻意的 —— 一旦中途失败，按已写好的清单回滚再整轮报错。
   * 并发写没法说清「写到第几个时失败」，也让回滚清单的边界失去意义。
   */
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

  const list = async (threadId: string, workspaceRoot: string): Promise<TurnChanges> => {
    const byTurn = new Map<number, TurnFileRow[]>()
    for (const row of d.repo.listByThread(threadId)) {
      const held = byTurn.get(row.turn)
      if (held === undefined) byTurn.set(row.turn, [row])
      else held.push(row)
    }
    const summaries =
      d.checkpoints === undefined
        ? new Map<number, CheckpointTurnSummary>()
        : await checkpointSummaries(d.checkpoints, threadId, workspaceRoot, d.logger, new Set(byTurn.keys()))
    const reverted = d.repo.revertedTurns(threadId)
    const turns: TurnChangesEntry[] = []
    const turnNumbers = [...new Set([...byTurn.keys(), ...summaries.keys()])].sort((a, b) => a - b)
    for (const turn of turnNumbers) {
      const rows = byTurn.get(turn) ?? []
      const summary = summaries.get(turn)
      let added = 0
      let removed = 0
      const files =
        summary === undefined
          ? rows.map((row) => {
              const stat = statOf(row.before, row.after)
              added += stat.added
              removed += stat.removed

              return { path: displayPath(workspaceRoot, row.path), added: stat.added, removed: stat.removed }
            })
          : summary.files.map((file) => {
              added += file.added
              removed += file.removed
              return { path: file.path, added: file.added, removed: file.removed }
            })
      turns.push({
        turn,
        fileCount: files.length,
        added,
        removed,
        /* 撤销之后行数仍报原值（那一轮确实改过这么多），只有这一格翻成 true。 */
        reverted: reverted.has(turn) || (rows.length > 0 && rows.every((row) => row.state === 'reverted')),
        files,
      })
    }

    return { turns }
  }

  const preview = async (threadId: string, turn: number, workspaceRoot: string): Promise<TurnRewindPreview> => {
    const rows = d.repo.listByTurn(threadId, turn)
    const alreadyReverted =
      d.repo.isTurnReverted(threadId, turn) || (rows.length > 0 && rows.every((row) => row.state === 'reverted'))
    if (alreadyReverted) throw notAvailable(threadId, turn)

    const checkpoints = d.checkpoints
    if (checkpoints !== undefined) {
      const plan = await checkpointPlan(checkpoints, threadId, workspaceRoot, turn, d.logger)
      if (plan !== null) {
        try {
          return await previewCheckpointPlan(checkpoints, workspaceRoot, plan)
        } catch (error) {
          d.logger.warn('checkpoint preview failed; falling back to ledger', {
            threadId,
            turn,
            error: String(error),
          })
        }
      }
    }

    if (rows.length === 0) throw notAvailable(threadId, turn)
    return await ledgerPreview(rows, workspaceRoot)
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

    async patch(threadId, turn, workspaceRoot, shownPath) {
      const wanted = shownPath.replaceAll('\\', '/')
      const row = d.repo.listByTurn(threadId, turn).find((held) => displayPath(workspaceRoot, held.path) === wanted)

      if (row !== undefined) return { before: row.before, after: row.after, binary: false }

      const checkpoints = d.checkpoints
      if (checkpoints !== undefined) {
        const plan = await checkpointPlan(checkpoints, threadId, workspaceRoot, turn, d.logger)
        if (plan?.paths.includes(wanted) === true) {
          return await checkpointPatch(checkpoints, workspaceRoot, plan, wanted, d.logger)
        }
      }

      throw new AppError(reviewErrors.turn_file_missing, '这一轮没有改过这个文件', { turn, path: shownPath })
    },

    preview,

    async apply(threadId, turn, workspaceRoot) {
      const rows = d.repo.listByTurn(threadId, turn)
      const alreadyReverted =
        d.repo.isTurnReverted(threadId, turn) || (rows.length > 0 && rows.every((row) => row.state === 'reverted'))
      if (alreadyReverted) throw notAvailable(threadId, turn)
      const checkpoints = d.checkpoints
      if (checkpoints !== undefined) {
        const plan = await checkpointPlan(checkpoints, threadId, workspaceRoot, turn, d.logger)
        if (plan !== null) {
          await restoreCheckpointPlan(checkpoints, workspaceRoot, plan)
          d.repo.markReverted(threadId, turn, now())
          d.emitChanged(threadId)
          return { turn, reverted: true }
        }
      }
      if (rows.length === 0) throw notAvailable(threadId, turn)
      const targets = await verified(rows, workspaceRoot)
      await restoreAll(targets, workspaceRoot, d.logger)
      d.repo.markReverted(threadId, turn, now())
      d.emitChanged(threadId)

      return { turn, reverted: true }
    },

    forgetThread(threadId) {
      d.repo.removeThread(threadId)
    },
  }
}
