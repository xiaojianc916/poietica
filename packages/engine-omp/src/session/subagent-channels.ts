import type { TranscriptOperation, TranscriptPage } from '@poietica/transcript'
import { outcomeOf } from '../errors'
import { isSubagentChannelId } from '../projector/agent-refs'
import { type OmpMessage, projectHistoryPage } from '../projector/history'
import { LiveProjector } from '../projector/live'
import { OpenTurnScreen, overlayOpenTurn } from '../projector/open-turn'
import { retryEndOf, retryStartOf } from '../projector/retry'

/*
 * 子代理通道：每个子代理一条与主对话**同形**的时间线（turn / step / frame），号是子代理的 id。
 *
 * 增量的产地是 omp 的子代理事件流（总线频道 `task:subagent:event`，载荷 `{ id, event }`，event 就是子代理
 * 自己那条 AgentSession 的事件，与主会话 subscribe 收到的是同一套词）；整页的产地是子代理自己的会话文件
 * （omp 的 `readRpcSubagentTranscript`，Agent Hub 读的也是它），投影走与主对话同一份 `projectHistoryPage`。
 * 两条路各用一个分轮口径会让「打开面板时的整页」与「之后的增量」对不上号，所以这里每个子代理也配一份
 * LiveProjector + OpenTurnScreen：与主对话一模一样的「封口的轮归历史、开着的轮归实时」。
 *
 * 纯逻辑，不 import omp：总线、会话文件的读法由宿主注入（subagent-host.ts），单测可以直接喂事件。
 */

export interface SubagentChannelsOptions {
  readonly now: () => number
  /** 把一个子代理通道的增量推出去（OmpSession.emitAgentTimeline） */
  readonly emit: (agentId: string, ops: readonly TranscriptOperation[]) => void
  /** 子代理会话文件里的消息（读不到 / 不认识交空表，不抛） */
  readonly readMessages: (agentId: string) => Promise<readonly OmpMessage[]>
  /** 投影出错只记日志：一条子代理事件翻译失败，不能连累主对话的事件泵 */
  readonly warn: (message: string, data: Record<string, unknown>) => void
}

interface Channel {
  readonly projector: LiveProjector
  readonly screen: OpenTurnScreen
  /** 最近一条落地的助手消息：轮终的结局由它决出（与主对话 finishTurn 同一条规矩） */
  last: { readonly stopReason?: string; readonly errorMessage?: string } | undefined
}

/** 用户消息正文里的文本（字符串或 text 块数组；图片块不计） */
export function userTextOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as readonly { readonly type?: unknown; readonly text?: unknown }[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

export class SubagentChannels {
  private readonly channels = new Map<string, Channel>()

  constructor(private readonly o: SubagentChannelsOptions) {}

  /** 总线上的一帧 `{ id, event }`；号不像子代理号（或会撞上 main）的整帧丢掉 */
  event(data: unknown): void {
    const frame = recordOf(data)
    const id = frame?.id
    const event = recordOf(frame?.event)
    if (typeof id !== 'string' || !isSubagentChannelId(id) || event === null) return
    try {
      this.translate(id, this.channelOf(id), event)
    } catch (error) {
      this.o.warn('subagent event projection failed', {
        agentId: id,
        type: typeof event.type === 'string' ? event.type : 'unknown',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * 一个子代理通道的一页：会话文件的历史投影，开着的那一轮换成实时版本。
   * 从没见过的号（Core 重启前的旧子代理）也照样读它的会话文件；文件也没有就是空页。
   */
  async page(agentId: string, beforeTurnId: string | null): Promise<TranscriptPage> {
    if (!isSubagentChannelId(agentId)) return projectHistoryPage([], null)
    const channel = this.channels.get(agentId)
    const view = channel?.screen.view() ?? null
    const messages = await this.o.readMessages(agentId)
    const page = projectHistoryPage(messages, beforeTurnId, {
      isTurnOpen: channel?.projector.isTurnOpen === true && view === null,
      openTurnAttachments: channel?.projector.openTurnAttachments ?? [],
    })
    return overlayOpenTurn(page, view, beforeTurnId === null)
  }

  private channelOf(id: string): Channel {
    const known = this.channels.get(id)
    if (known !== undefined) return known
    const channel: Channel = {
      projector: new LiveProjector({ now: this.o.now }),
      screen: new OpenTurnScreen(),
      last: undefined,
    }
    this.channels.set(id, channel)
    return channel
  }

  private push(id: string, channel: Channel, ops: readonly TranscriptOperation[]): void {
    if (ops.length === 0) return
    /* 与主对话同一条规矩：先记进开轮屏，再发出去 —— 整页随时可能在这两步之间来取 */
    if (!channel.screen.observe(ops)) this.o.warn('subagent open turn screen diverged', { agentId: id })
    this.o.emit(id, ops)
  }

  /** 子代理事件 → ops：与主会话 dispatchOmpEvent 同一套词，只是没有队列、交互、目标这些主对话独有的格 */
  private translate(id: string, channel: Channel, event: Record<string, unknown>): void {
    switch (event.type) {
      case 'message_start':
        this.messageStart(id, channel, recordOf(event.message))
        break
      case 'message_update':
        this.messageUpdate(id, channel, recordOf(event.assistantMessageEvent))
        break
      case 'message_end':
        messageEnd(channel, recordOf(event.message))
        break
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        this.push(id, channel, toolOps(channel.projector, event))
        break
      case 'notice':
        if (event.level === 'error' || event.level === 'warning') {
          const source = typeof event.source === 'string' ? event.source : undefined
          this.push(id, channel, channel.projector.notice(event.level, String(event.message), source))
        }
        break
      /* 与主会话同一套：一次重试过程只占一格，原地改写 */
      case 'auto_retry_start':
        this.push(id, channel, channel.projector.retryStart(retryStartOf(event)))
        break
      case 'auto_retry_end':
        this.push(id, channel, channel.projector.retryEnd(retryEndOf(event)))
        break
      case 'agent_end':
        this.agentEnd(id, channel)
        break
      /* 压缩、队列、模型切换这些不进子代理通道：面板只画对话本身，压缩之后整页仍按会话文件来 */
      default:
        break
    }
  }

  private messageStart(id: string, channel: Channel, message: Record<string, unknown> | null): void {
    const { projector } = channel
    if (message?.role === 'assistant') {
      projector.assistantMessageStart()
      return
    }
    if (message?.role !== 'user') return
    const text = userTextOf(message.content)
    if (text === '') return
    /* 开着一轮时是插话（父代理或人引导的那一句），否则开新的一轮：历史那条路按同一个口径分轮 */
    this.push(id, channel, projector.isTurnOpen ? projector.steeredFrame(text) : projector.userTurn({ text }))
  }

  private messageUpdate(id: string, channel: Channel, assistant: Record<string, unknown> | null): void {
    const delta = assistant?.delta
    if (typeof delta !== 'string') return
    const index = typeof assistant?.contentIndex === 'number' ? assistant.contentIndex : undefined
    if (assistant?.type === 'text_delta') this.push(id, channel, channel.projector.textDelta(delta, index))
    else if (assistant?.type === 'thinking_delta') this.push(id, channel, channel.projector.thinkingDelta(delta, index))
  }

  private agentEnd(id: string, channel: Channel): void {
    const { outcome, message } = outcomeOf(channel.last)
    try {
      this.push(id, channel, channel.projector.turnEnd(outcome, message))
    } finally {
      /* 投影成不成功都复位：否则下一句引导会落进已经结束的那一轮 */
      channel.projector.abandonTurn()
      channel.last = undefined
    }
  }
}

/** 记下这一条助手消息的收尾原因：agent_end 据此判这一轮成功 / 失败 / 被中止。 */
function messageEnd(channel: Channel, message: Record<string, unknown> | null): void {
  if (message?.role !== 'assistant') return
  channel.last = {
    ...(typeof message.stopReason === 'string' ? { stopReason: message.stopReason } : {}),
    ...(typeof message.errorMessage === 'string' ? { errorMessage: message.errorMessage } : {}),
  }
}

/** 工具三帧：同一个 toolCallId / toolName，各自带开始的入参、中途的部分结果、结束的结果。 */
function toolOps(projector: LiveProjector, event: Record<string, unknown>): TranscriptOperation[] {
  const toolCallId = String(event.toolCallId)
  const toolName = String(event.toolName)
  if (event.type === 'tool_execution_start') {
    return projector.toolStart({
      toolCallId,
      toolName,
      args: event.args,
      ...(typeof event.intent === 'string' ? { intent: event.intent } : {}),
    })
  }
  if (event.type === 'tool_execution_update') {
    return projector.toolUpdate({ toolCallId, toolName, partial: event.partialResult })
  }
  return projector.toolEnd({
    toolCallId,
    toolName,
    result: event.result,
    ...(event.isError === true ? { isError: true } : {}),
  })
}
