import type { BtwHistoryRecord, BtwHistoryTurn } from '@oh-my-pi/pi-coding-agent/session/btw-history'
import { EngineErrorCode, type EngineSessionEvent, type SideTopic, type SideTurn } from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import { describeError } from './event-faults'

/**
 * 侧边提问（omp 的 `/btw`）：把 omp 的 RpcBtwController 接到端口的 askSide / cancelSide / sideTopics 上。
 * omp 知识 #21：`/btw` 走 `AgentSession.runEphemeralTurn` —— 拿会话的模型、系统提示与此刻的历史快照
 * 问一句，与主轮共用提示缓存，不写会话历史、从不执行工具。话题存在
 * `<artifactsDir>/btw-history/entry-<id>.json`，与 TUI / RPC 宿主读写同一份：删会话一起删，分叉一起复制。
 * 这一层只做三件事：把 omp 的记录摊平成端口的 `SideTopic`；在 omp 之前把「忙 / 话题不存在 / 没有模型」
 * 判掉并报成带码的 AppError（omp 只抛裸 Error，按字面匹配太脆）；给每截流式输出配 `offset` 与问题下标。
 */

/** RpcBtwController 的输出帧（rpc-btw.ts 的 RpcBtwOutputFrame；那个类型没有导出，按结构抄一份） */
export type BtwFrame =
  | { readonly type: 'btw_record'; readonly record: BtwHistoryRecord }
  | { readonly type: 'btw_delta'; readonly recordId: string; readonly delta: string }
  | { readonly type: 'notice'; readonly level: 'error'; readonly message: string; readonly source: 'btw-history' }

/** RpcBtwController 上用到的四个方法（按结构收窄：测试换替身，生产就是 omp 的那个类） */
export interface BtwControllerLike {
  ask(question: string, recordId?: string): Promise<BtwHistoryRecord>
  cancel(recordId?: string): boolean
  history(): Promise<readonly BtwHistoryRecord[]>
  close(): Promise<void>
}

export type SideEvent = Extract<EngineSessionEvent, { readonly type: 'sideTopic' | 'sideDelta' | 'sideNotice' }>

export interface SideQuestionsDeps {
  /** 造控制器：输出帧交给本类的 `onFrame`（构造期就要接上，控制器没有事后订阅的口） */
  readonly createController: (output: (frame: BtwFrame) => void) => BtwControllerLike
  /** 会话此刻有没有可用模型（omp 的 `session.model`）：没有就别去开问 —— omp 会先落一笔再报错 */
  readonly hasModel: () => boolean
  readonly emit: (event: SideEvent) => void
  readonly logger: Logger
}

/** 正在答的那一问：话题号、问题下标、已经流出来的字数（下一截的 offset） */
interface Running {
  readonly topicId: string
  readonly turn: number
  length: number
}

export class SideQuestions {
  private readonly controller: BtwControllerLike
  /** 从 askSide 进门到 omp 开问返回之间（含先读一遍历史核对话题号） */
  private starting = false
  /** 开问期间按了停止：omp 那一侧可能还没进门（还在核对话题号），由这里记住、进门前收手 */
  private stopRequested = false
  private running: Running | null = null
  private closed = false

  constructor(private readonly d: SideQuestionsDeps) {
    this.controller = d.createController((frame) => this.onFrame(frame))
  }

  /** 有一问在开或在答：会话池不能回收这条会话（端口的 isBusy） */
  get busy(): boolean {
    return this.starting || this.running !== null
  }

  async ask(question: string, topicId: string | null): Promise<SideTopic> {
    const text = question.trim()
    if (text === '') throw new AppError(SystemErrorCode.invalidParams, '侧边提问不能为空')
    if (this.busy) throw new AppError(EngineErrorCode.sideBusy, '上一个侧边提问还没答完')
    if (!this.d.hasModel()) throw new AppError(EngineErrorCode.sideUnavailable, '这条对话还没有可用的模型')
    this.starting = true
    this.stopRequested = false
    try {
      if (topicId !== null) {
        const known = await this.controller.history()
        if (!known.some((record) => record.id === topicId)) {
          throw new AppError(EngineErrorCode.sideTopicUnknown, `找不到这个侧边话题：${topicId}`)
        }
      }
      if (this.stopRequested) throw new AppError(SystemErrorCode.cancelled, '侧边提问已停止')
      return topicOf(await this.controller.ask(text, topicId ?? undefined))
    } catch (error) {
      if (error instanceof AppError) throw error
      /* omp 在开问途中被停（epoch 变了）抛的是裸 Error：停止是人按的，按 cancelled 报，不当成失败 */
      if (this.stopRequested) throw new AppError(SystemErrorCode.cancelled, '侧边提问已停止')
      throw new AppError(EngineErrorCode.sideFailed, describeError(error))
    } finally {
      this.starting = false
    }
  }

  cancel(topicId: string | null): boolean {
    if (this.controller.cancel(topicId ?? undefined)) {
      if (this.starting) this.stopRequested = true
      return true
    }
    /* omp 还没进门（还在核对话题号）：只能由这一层记下，进门前收手。给了话题号时不猜它是不是正在开的那一个 */
    if (this.starting && topicId === null) {
      this.stopRequested = true
      return true
    }
    return false
  }

  async topics(): Promise<readonly SideTopic[]> {
    return (await this.controller.history()).map(topicOf)
  }

  /**
   * 会话关闭前：停掉在答的那一问并等收口的那一笔落盘（omp 的 close 失败重试一次后才抛）。
   * 抛了也只记日志 —— 关会话不能被一笔侧边存档拦住，丢的是那一问的答案，sideNotice 已经说过了。
   */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    try {
      await this.controller.close()
    } catch (error) {
      this.d.logger.warn('side question history not saved on close', { error: describeError(error) })
    }
  }

  private onFrame(frame: BtwFrame): void {
    switch (frame.type) {
      case 'btw_record': {
        const topic = topicOf(frame.record)
        const turn = topic.turns.length - 1
        const latest = topic.turns[turn]
        if (latest?.status === 'running') {
          this.running = { topicId: topic.id, turn, length: latest.answer.length }
        } else if (this.running?.topicId === topic.id) {
          this.running = null
        }
        this.d.emit({ type: 'sideTopic', topic })
        break
      }
      case 'btw_delta': {
        const run = this.running
        /* 收口之后迟到的一截（停止与流式撞车）：快照已经是定稿，不再往上拼 */
        if (run === null || run.topicId !== frame.recordId) return
        const offset = run.length
        run.length += frame.delta.length
        this.d.emit({ type: 'sideDelta', topicId: run.topicId, turn: run.turn, offset, delta: frame.delta })
        break
      }
      case 'notice':
        this.d.logger.warn('side question notice', { message: frame.message })
        this.d.emit({ type: 'sideNotice', message: frame.message })
        break
    }
  }
}

/**
 * 存档里的话题 → 端口的话题表：新开的在前，同一刻开的按号排（omp `RpcBtwController.history` 同一条次序）。
 * 冷读（SessionFilesPort.sideTopics）用它；活会话问控制器，控制器自己排。
 */
export function sideTopicsOf(records: readonly BtwHistoryRecord[]): SideTopic[] {
  return [...records].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id)).map(topicOf)
}

/** omp 的一条记录（首问 + followUps）→ 端口的话题（问题表摊平；omp 的 getBtwTurns 同一个次序） */
export function topicOf(record: BtwHistoryRecord): SideTopic {
  return { id: record.id, leafId: record.leafId, turns: [record, ...(record.followUps ?? [])].map(turnOf) }
}

function turnOf(turn: BtwHistoryTurn): SideTurn {
  return {
    question: turn.question,
    answer: turn.answer,
    status: turn.status,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    error: turn.error ?? null,
  }
}
