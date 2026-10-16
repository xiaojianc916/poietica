import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { exportFromFile } from '@oh-my-pi/pi-coding-agent/export/html'
import type { SessionEntry } from '@oh-my-pi/pi-coding-agent/session/session-entries'
import { formatSessionHistoryMarkdown } from '@oh-my-pi/pi-coding-agent/session/session-history-format'
import { loadSessionMessagesReadOnly } from '@oh-my-pi/pi-coding-agent/session/session-loader'
import { SessionManager } from '@oh-my-pi/pi-coding-agent/session/session-manager'
import { FileSessionStorage } from '@oh-my-pi/pi-coding-agent/session/session-storage'
import type { SessionFilesPort } from '@poietica/engine'
import { EngineErrorCode } from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import { toEngineError } from '../errors'
import { type OmpMessage, turnOpenings } from '../projector/history'

/** SessionFilesPort 需要的东西：omp 的会话目录，以及一个只用来记异常的 logger。 */
export interface SessionFilesPortDeps {
  /** omp 的会话目录（getSessionsDir(agentDir)，即 <ompAgentDir>/sessions） */
  readonly sessionDir: string
  readonly logger: Logger
}

/**
 * 会话文件端口。omp 的会话文件在**首次水合之后**才落盘（omp 知识 #14）：
 * SessionManager.create 只签发号，文件要到第一条消息才出现。所以 fork / export / delete
 * 一律先 exists 校验，不存在时报 engine.session_file_missing —— 不把一个刚签发、还没落盘的
 * 会话当成丢了。
 */
export class OmpSessionFilesPort implements SessionFilesPort {
  constructor(private readonly d: SessionFilesPortDeps) {}

  async exists(sessionFile: string): Promise<boolean> {
    try {
      const info = await stat(sessionFile)
      return info.isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw toEngineError(error)
    }
  }

  async fork(sessionFile: string, keepTurns?: number): Promise<{ sessionId: string; sessionFile: string }> {
    try {
      await this.requireFile(sessionFile)
      /*
       * forkFrom 先整份克隆（含 artifacts），得到一条独立的新会话；截断只发生在副本上，
       * 原文件全程只读 —— 正在跑的那条会话不会被我们抢走单写者锁。
       */
      const forked = await SessionManager.forkFrom(sessionFile, path.dirname(sessionFile), this.d.sessionDir)
      try {
        if (keepTurns !== undefined) keepFirstTurns(forked, keepTurns)
        const created = forked.getSessionFile()
        if (created === undefined) throw new AppError(SystemErrorCode.internal, 'omp 没有为新会话签发文件')
        return { sessionId: forked.getSessionId(), sessionFile: created }
      } finally {
        await forked.close()
      }
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async delete(sessionFile: string): Promise<void> {
    try {
      await this.requireFile(sessionFile)
      /* 文件与它的产物目录一起删；omp 自己的选择器同此处理。 */
      await new FileSessionStorage().deleteSessionWithArtifacts(sessionFile)
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async exportHtml(sessionFile: string, outFile: string): Promise<void> {
    try {
      await this.requireFile(sessionFile)
      await mkdir(path.dirname(outFile), { recursive: true })
      const written = await exportFromFile(sessionFile, { outputPath: outFile })
      if (written === undefined) {
        throw new AppError(SystemErrorCode.internal, `omp 没能导出会话：${sessionFile}`)
      }
    } catch (error) {
      throw toEngineError(error)
    }
  }

  async exportMarkdown(sessionFile: string): Promise<string> {
    try {
      await this.requireFile(sessionFile)
      return markdownOf(await loadSessionMessagesReadOnly(sessionFile))
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 会话文件不存在时抛 engine.session_file_missing（omp 知识 #14）。 */
  private async requireFile(sessionFile: string): Promise<void> {
    if (!(await this.exists(sessionFile))) {
      throw new AppError(EngineErrorCode.sessionFileMissing, `会话文件不存在：${sessionFile}`)
    }
  }
}

/**
 * 只留屏幕上的前 `keep` 轮：在副本上把叶子挪到第 `keep + 1` 轮开场消息之前，并且**落盘**。
 *
 * 轮怎么分只有一个产地 —— `turnOpenings`，与时间线的历史分页同一套（它读的也是同一份「显示经过」）。
 * 所以屏幕上的第 n 轮就是这里的第 n 轮：目标续跑、技能、压缩、插话都不需要另外数一遍。
 *
 * 只 `branch()` 是不够的：它只改内存里的叶子，omp 重开会话时按**最后一条物理记录**还原叶子，
 * 副本关掉再打开就又是整条历史。`branchWithSummary` 追加一条空摘要的分支记录（omp 自己
 * `discardEntryDurably` 也是这样做的），叶子因此落在磁盘上；空摘要既不上屏也不进模型上下文。
 */
function keepFirstTurns(manager: SessionManager, keep: number): void {
  const transcript = manager.buildSessionContext({ transcript: true, collapseCompactedHistory: false })
  const messages = transcript.messages as unknown as readonly OmpMessage[]
  const openings = turnOpenings(messages)
  /* 超出现有轮数不夹到边界：静默夹会让「留 5 轮」变成「留 3 轮」而没人知道。 */
  if (!Number.isInteger(keep) || keep < 1 || keep > openings.length) {
    throw new AppError(SystemErrorCode.invalidParams, `这条会话只有 ${openings.length} 轮，不能只留前 ${keep} 轮`)
  }
  if (keep === openings.length) return
  const cut = entryOf(manager.getBranch(), messages, openings[keep]!)
  if (cut === undefined || cut.parentId === null) {
    throw new AppError(SystemErrorCode.internal, `找不到第 ${keep + 1} 轮开场消息在会话里的位置`)
  }
  manager.branchWithSummary(cut.parentId, '', { kind: 'poietica-fork', keepTurns: keep })
}

/**
 * 一条「显示经过」里的消息落在哪条会话记录上。两份都按路径顺序排，逐条往前对：消息记录按 role + 时刻认，
 * 自定义消息按时刻认（omp 现造对象，号认不了），压缩与分支摘要按种类认 —— 不产出消息的记录被跳过。
 */
function entryOf(
  path: readonly SessionEntry[],
  messages: readonly OmpMessage[],
  target: OmpMessage,
): SessionEntry | undefined {
  let at = 0
  for (const message of messages) {
    while (at < path.length && !produces(path[at]!, message)) at += 1
    if (at >= path.length) return undefined
    if (message === target) return path[at]
    at += 1
  }
  return undefined
}

function produces(entry: SessionEntry, message: OmpMessage): boolean {
  switch (entry.type) {
    case 'message':
      return (
        entry.message === (message as unknown) ||
        (entry.message.role === message.role && entry.message.timestamp === message.timestamp)
      )
    case 'custom_message':
      return message.role === 'custom' && new Date(entry.timestamp).getTime() === message.timestamp
    case 'compaction':
      return message.role === 'compactionSummary'
    case 'branch_summary':
      return message.role === 'branchSummary'
    default:
      return false
  }
}

/**
 * 会话正文 → markdown。用 omp 自己的 formatSessionHistoryMarkdown（`history://` 那份的产地）：
 * 它把工具调用与结果收成单行、思考默认省略、图记成 `[image]`，不必我们维护第二套消息形状。
 */
function markdownOf(messages: readonly unknown[]): string {
  return formatSessionHistoryMarkdown([...messages], { title: '会话' })
}
