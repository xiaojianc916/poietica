import { stat } from 'node:fs/promises'
import path from 'node:path'
import { readRpcSubagentTranscript } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents'
import { deobfuscateSessionContext } from '@oh-my-pi/pi-coding-agent/secrets/message-transform'
import type { SecretObfuscator } from '@oh-my-pi/pi-coding-agent/secrets/obfuscator'
import {
  createInterruptedToolResults,
  createInterruptedTurnAbortMessage,
} from '@oh-my-pi/pi-coding-agent/session/exit-diagnostics'
import { SessionManager } from '@oh-my-pi/pi-coding-agent/session/session-manager'
import { getLatestTodoPhasesFromEntries } from '@oh-my-pi/pi-coding-agent/tools/todo'
import { EngineErrorCode, type PageOptions } from '@poietica/engine'
import { AppError, type Logger } from '@poietica/foundation'
import type { TranscriptPage, TranscriptTodo } from '@poietica/transcript'
import { toEngineError } from '../errors'
import { isSubagentChannelId } from '../projector/agent-refs'
import { type OmpMessage, projectHistoryPage } from '../projector/history'
import type { MediaRef } from '../projector/media'
import { TodoMirror } from '../projector/todos'

export interface SessionHistoryDeps {
  /** 与活会话同一个 MediaRef（create-engine 里那一个）：两条路交出的图片地址必须一模一样 */
  readonly mediaRef: MediaRef
  /**
   * `secrets.enabled` 开着时给这条会话的 cwd 造混淆器（omp 的 buildSecretObfuscator），关着交 undefined。
   * 会话文件里存的是混淆后的占位符，活会话打开时 omp 用同一个混淆器还原后才上屏 —— 冷读不还原，屏幕上就是一串占位符。
   */
  readonly obfuscatorFor: (cwd: string) => Promise<SecretObfuscator | undefined>
  readonly now: () => number
  readonly logger: Logger
}

/** 冷读一次的成果：显示经过 + 待办。翻页（加载更早）复用它，不再整份重读、重解析会话文件 */
interface ColdTranscript {
  readonly size: number
  readonly mtimeMs: number
  readonly messages: readonly OmpMessage[]
  readonly todo: TranscriptTodo | null
}

/**
 * 缓存几份、多大：只为「刚打开的那条历史对话往上翻」服务，不是第二份会话库。
 * 份数小、字节有上限 —— 消息里的图片已经被 omp 读成 base64，大会话整份留在内存里不划算；超限的文件不进缓存（每页现读）。
 */
const CACHE_ENTRIES = 3
const CACHE_MAX_FILE_BYTES = 16 * 1024 * 1024

/**
 * 没开着的会话的只读时间线（`SessionFilesPort.readPage` 的实现）。
 *
 * 与活会话**同一个产地**：消息取 omp `SessionManager.buildSessionContext({ transcript: true, collapseCompactedHistory: false })`
 * （活会话 `buildTranscriptSessionContext` 内部调的就是它），分页走同一个 `projectHistoryPage`，待办走同一个 `TodoMirror` ——
 * 两条路不各算一份，live/history 的一致性才不靠巧合。只有活会话打开时会**写进文件**的那两处在这里改成内存里的等价物：
 * - 非正常退出留下的半截轮：omp 重开时追加「中断」的工具结果与一条 aborted 回复（sdk 的 createInterruptedTurnAbortMessage）；
 *   这里只在内存里补上同样两样，文件不动 —— 否则先冷读、后打开的屏幕会少那一格「已中断」，而打开不发增量补它。
 * - 密钥混淆：见 `SessionHistoryDeps.obfuscatorFor`。
 *
 * 打开用 `suppressBreadcrumb`、从不写入，所以不抢单写者锁、不留面包屑；`close()` 只放掉文件句柄。
 */
export class SessionHistoryReader {
  /** 插入序 = 最近使用序（读到就删了再插）；值是 Promise，同一份文件的并发冷读只解析一次 */
  private readonly cache = new Map<string, Promise<ColdTranscript>>()

  constructor(private readonly d: SessionHistoryDeps) {}

  async page(
    sessionFile: string,
    agentId: string,
    beforeTurnId: string | null,
    options?: PageOptions,
  ): Promise<TranscriptPage> {
    try {
      if (agentId !== 'main') return await this.subagentPage(sessionFile, agentId, beforeTurnId)
      const cold = await this.transcriptOf(sessionFile)
      const through = options?.throughTurnId
      const page = projectHistoryPage(cold.messages, beforeTurnId, {
        mediaRef: this.d.mediaRef,
        ...(through === undefined ? {} : { throughTurnId: through }),
      })
      /* 与活会话 page() 同一条规矩：待办是会话级的、不分页，每一页都带同一份；没开着的会话没有子代理行与后台作业 */
      return { ...page, todos: cold.todo === null ? [] : [cold.todo] }
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 会话文件被删（线程删除）时由端口调用：别让一份已经不存在的正文留在缓存里 */
  forget(sessionFile: string): void {
    this.cache.delete(sessionFile)
  }

  private async transcriptOf(sessionFile: string): Promise<ColdTranscript> {
    const info = await statOf(sessionFile)
    const held = this.cache.get(sessionFile)
    if (held !== undefined) {
      const cold = await held.catch(() => null)
      if (cold !== null && cold.size === info.size && cold.mtimeMs === info.mtimeMs) {
        /* 刷新最近使用序 */
        this.cache.delete(sessionFile)
        this.cache.set(sessionFile, held)
        return cold
      }
      this.cache.delete(sessionFile)
    }
    const loading = this.load(sessionFile, info)
    if (info.size > CACHE_MAX_FILE_BYTES) return await loading
    this.cache.set(sessionFile, loading)
    while (this.cache.size > CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
    try {
      return await loading
    } catch (error) {
      /* 读失败不缓存：下次重试要真的再读一次 */
      if (this.cache.get(sessionFile) === loading) this.cache.delete(sessionFile)
      throw error
    }
  }

  private async load(sessionFile: string, info: { size: number; mtimeMs: number }): Promise<ColdTranscript> {
    const manager = await SessionManager.open(sessionFile, path.dirname(sessionFile), undefined, {
      throwIfMissing: true,
      suppressBreadcrumb: true,
    })
    try {
      const branch = manager.getBranch()
      const context = manager.buildSessionContext({ transcript: true, collapseCompactedHistory: false })
      const shown = deobfuscateSessionContext(context, await this.d.obfuscatorFor(manager.getCwd())).messages
      const abort = createInterruptedTurnAbortMessage(branch)
      const messages = (abort === undefined
        ? shown
        : [...shown, ...createInterruptedToolResults(branch), abort]) as unknown as readonly OmpMessage[]
      const todos = new TodoMirror(this.d.now)
      todos.sync(getLatestTodoPhasesFromEntries(branch))
      return { size: info.size, mtimeMs: info.mtimeMs, messages, todo: todos.current }
    } finally {
      await manager.close().catch((error: unknown) => {
        this.d.logger.warn('cold session reader close failed', { sessionFile, error: String(error) })
      })
    }
  }

  /**
   * 子代理通道：与活会话 `SubagentChannels.page` 同一个读法（`readRpcSubagentTranscript` + 同一个投影），文件取
   * `<会话产物目录>/<agentId>.jsonl` —— 刚打开的活会话里子代理登记表也是空的，走的正是这条兜底路径。读不到交空页。
   */
  private async subagentPage(
    sessionFile: string,
    agentId: string,
    beforeTurnId: string | null,
  ): Promise<TranscriptPage> {
    if (!isSubagentChannelId(agentId) || !sessionFile.endsWith('.jsonl')) return projectHistoryPage([], null)
    const file = path.join(sessionFile.slice(0, -'.jsonl'.length), `${agentId}.jsonl`)
    try {
      const messages = (await readRpcSubagentTranscript(file)).messages as unknown as readonly OmpMessage[]
      return projectHistoryPage(messages, beforeTurnId, {})
    } catch (error) {
      this.d.logger.warn('subagent transcript read failed', { agentId, error: String(error) })
      return projectHistoryPage([], null)
    }
  }
}

async function statOf(sessionFile: string): Promise<{ size: number; mtimeMs: number }> {
  try {
    const info = await stat(sessionFile)
    if (!info.isFile()) throw new AppError(EngineErrorCode.sessionFileMissing, `会话文件不存在：${sessionFile}`)
    return { size: info.size, mtimeMs: info.mtimeMs }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new AppError(EngineErrorCode.sessionFileMissing, `会话文件不存在：${sessionFile}`)
    }
    throw error
  }
}
