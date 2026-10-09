import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { exportFromFile } from '@oh-my-pi/pi-coding-agent/export/html'
import { loadSessionMessagesReadOnly } from '@oh-my-pi/pi-coding-agent/session/session-loader'
import { SessionManager } from '@oh-my-pi/pi-coding-agent/session/session-manager'
import { FileSessionStorage } from '@oh-my-pi/pi-coding-agent/session/session-storage'
import type { SessionFilesPort } from '@poietica/engine'
import { EngineErrorCode } from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import { toEngineError } from '../errors'

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

  async fork(sessionFile: string, undoTurns: number): Promise<{ sessionId: string; sessionFile: string }> {
    try {
      await this.requireFile(sessionFile)
      /*
       * forkFrom 先整份克隆（含 artifacts），得到一条独立的新会话；截断只发生在副本上，
       * 原文件全程只读 —— 正在跑的那条会话不会被我们抢走单写者锁。
       */
      const forked = await SessionManager.forkFrom(sessionFile, path.dirname(sessionFile), this.d.sessionDir)
      try {
        if (undoTurns > 0) truncateTurns(forked, undoTurns)
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

/** 丢掉最后 undoTurns 轮：在副本上重锚到「第一个被丢掉的用户消息」之前。 */
function truncateTurns(manager: SessionManager, undoTurns: number): void {
  const users = manager.getBranch().filter((entry) => entry.type === 'message' && entry.message.role === 'user')
  /* 超出可丢的轮数不夹到边界：静默夹会让「丢 5 轮」变成「丢 3 轮」而没人知道。 */
  if (undoTurns > users.length) {
    throw new AppError(SystemErrorCode.invalidParams, `只能丢 ${users.length} 轮，要求丢 ${undoTurns} 轮`)
  }
  const anchor = users[users.length - undoTurns]
  if (anchor === undefined) throw new AppError(SystemErrorCode.invalidParams, `没有可截断的轮次：${undoTurns}`)
  if (anchor.parentId === null) {
    /* 丢到一轮不剩：清空到只有表头，与 omp 官方 branch(null) 同义。 */
    manager.resetLeaf()
    return
  }
  manager.branch(anchor.parentId)
}

/** 一条消息里我们认得出的那几格。 */
interface MessageLike {
  readonly role?: string
  readonly content?: unknown
}

/**
 * 会话正文 → markdown。legacy 没有这个函数的实现，按其会话形状补写：只处理纯文本与
 * 工具调用两种块 —— 图与附件是二进制，markdown 里放 data URL 既大又没人看。
 */
function markdownOf(messages: readonly unknown[]): string {
  const lines: string[] = ['# 会话', '']
  for (const raw of messages) {
    const message = raw as MessageLike
    const role = message.role
    if (role !== 'user' && role !== 'assistant') continue
    const text = textOf(message.content)
    if (text === '') continue
    lines.push(role === 'user' ? '## 用户' : '## 助手', '', text, '')
  }
  return lines.join(`n`)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const typed = block as { type?: string; text?: string; name?: string }
    if (typed.type === 'text' && typeof typed.text === 'string') {
      parts.push(typed.text)
      continue
    }
    if (typed.type === 'toolCall') parts.push(`> 调用工具 ${typed.name ?? ''}`)
  }
  return parts.join(`n` + 'n')
}
