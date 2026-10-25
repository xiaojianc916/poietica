import { join } from 'node:path'
import { RpcSubagentRegistry, readRpcSubagentTranscript } from '@oh-my-pi/pi-coding-agent/modes/rpc/rpc-subagents'
import { TASK_SUBAGENT_EVENT_CHANNEL } from '@oh-my-pi/pi-coding-agent/task/types'
import { EngineErrorCode } from '@poietica/engine'
import { AppError, type Logger } from '@poietica/foundation'
import type { TranscriptOperation, TranscriptPage } from '@poietica/transcript'
import { isSubagentChannelId } from '../projector/agent-refs'
import type { OmpMessage } from '../projector/history'
import { SubagentChannels } from './subagent-channels'

/*
 * 子代理的宿主面：通道（实时 + 整页）、停止、引导。**全走 omp 自己给 RPC 宿主的那几条路**，不自己拼：
 * 名册与会话文件走 `RpcSubagentRegistry`（它自己订生命周期 / 进度帧，记住已结束子代理的会话文件）；
 * 停止走 `handleRpcCancelSubagent`（先立墓碑再 abort，父轮收下的是「被停了」，不会把半截结果当成功）；
 * 引导走 `handleRpcSteerSubagent`（Agent Hub 聊天同一条路，这句话记进子代理自己的会话）。
 * 自己拿 AgentRegistry 找会话再 abort / prompt，就绕过了归属校验（同名子代理可能属于别的会话）与墓碑。
 */

/** omp 的 EventBus 面（会话自己那一条 subagentEventBus；按结构收窄） */
export interface SubagentBus {
  on(channel: string, listener: (data: unknown) => void): () => void
}

export interface SubagentHostOptions {
  readonly bus: SubagentBus
  readonly now: () => number
  readonly logger: Logger
  readonly emit: (agentId: string, ops: readonly TranscriptOperation[]) => void
  /** 会话的 artifacts 目录：名册里没有（Core 重启前的旧子代理）时按 omp 的布局 `<dir>/<id>.jsonl` 找会话文件 */
  readonly artifactsDir: () => string | null
}

export interface SubagentHost {
  page(agentId: string, beforeTurnId: string | null): Promise<TranscriptPage>
  cancel(agentId: string): Promise<boolean>
  steer(agentId: string, text: string): Promise<void>
  dispose(): void
}

type RegistryBus = ConstructorParameters<typeof RpcSubagentRegistry>[0]

/** RPC 处理函数所在的模块很重（整个 RPC 宿主）：只在真的停 / 引导时才加载 */
async function rpcHandlers(): Promise<typeof import('@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode')> {
  return await import('@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode')
}

export function createSubagentHost(o: SubagentHostOptions): SubagentHost {
  /* 名册只用来查会话文件与归属；它不往外发帧（订阅档位留在 off） */
  const registry = new RpcSubagentRegistry(o.bus as unknown as RegistryBus, () => undefined)

  const sessionFileOf = (agentId: string): string | null => {
    try {
      return registry.resolveSessionFile({ subagentId: agentId })
    } catch {
      const dir = o.artifactsDir()
      return dir === null ? null : join(dir, `${agentId}.jsonl`)
    }
  }

  const channels = new SubagentChannels({
    now: o.now,
    emit: o.emit,
    warn: (message, data) => o.logger.warn(message, data),
    readMessages: async (agentId) => {
      const file = sessionFileOf(agentId)
      if (file === null) return []
      try {
        return (await readRpcSubagentTranscript(file)).messages as unknown as readonly OmpMessage[]
      } catch (error) {
        o.logger.warn('subagent transcript read failed', {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        })
        return []
      }
    },
  })
  const unsubscribe = o.bus.on(TASK_SUBAGENT_EVENT_CHANNEL, (data) => channels.event(data))

  return {
    page: async (agentId, beforeTurnId) => await channels.page(agentId, beforeTurnId),
    cancel: async (agentId) => {
      if (!isSubagentChannelId(agentId)) return false
      const { handleRpcCancelSubagent } = await rpcHandlers()
      return await handleRpcCancelSubagent(registry, agentId)
    },
    steer: async (agentId, text) => {
      const refused = isSubagentChannelId(agentId)
        ? await (await rpcHandlers()).handleRpcSteerSubagent(registry, agentId, text)
        : 'unknown subagent'
      if (refused === undefined) return
      o.logger.info('subagent steer refused', { agentId, reason: refused })
      throw new AppError(EngineErrorCode.subagentNotRunning, '这个子代理已经结束了')
    },
    dispose: () => {
      unsubscribe()
      registry.dispose()
    },
  }
}
