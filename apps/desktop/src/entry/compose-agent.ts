import { createPreference } from '@poietica/external-store'
import {
  type AgentBridgeOptions,
  createAgentCapabilityBridge,
  createAgentSessionConfigBridge,
  createAgentSessionPort,
  createAgentSessionUsageBridge,
  createAgentThreadBridge,
  type PickSavePath,
} from '@poietica/native-bridge/conversation'
import { error as reportError } from '@poietica/problem'
import type { ModelCatalogStore } from '@poietica/settings'
import { createAgentRuntime, type DesktopAgentRuntime } from '../assistant/agent-runtime'
import { createControlsMemory } from '../assistant/controls-memory'
import { createThinkingPreference } from '../assistant/thinking-preference'

interface DesktopAgentRuntimeOptions {
  readonly modelCatalog: ModelCatalogStore
  readonly cwd: NonNullable<AgentBridgeOptions['cwd']>
  readonly mcpReady: () => Promise<void>
  /** 会话导出的落点由宿主给；组合根注入，这一层不认识宿主端口。 */
  readonly pickSavePath: PickSavePath
}

export function createDesktopAgentRuntime(
  options: DesktopAgentRuntimeOptions,
): DesktopAgentRuntime {
  const posture = createPreference<string | undefined>({
    key: 'poietica.permission-posture',
    fallback: undefined,
    decode: (raw) => raw,
    encode: (value) => value ?? null,
    onFailure: (failure) => {
      reportError('permission posture preference failed', {
        scope: 'agent-runtime',
        operation: failure.stage,
        cause: failure.cause,
      })
    },
  })
  const thinking = createThinkingPreference((failure) => {
    reportError('Thinking preference failed', {
      scope: 'agent-runtime',
      operation: failure.stage,
      cause: failure.cause,
    })
  })
  const controlsMemory = createControlsMemory((failure) => {
    reportError('session controls memory failed', {
      scope: 'agent-runtime',
      operation: failure.stage,
      cause: failure.cause,
    })
  })
  /*
   * 这一条同时接两种失败：订阅本身没装上，以及**一条帧没过边界校验**（session.ts 的解码
   * 失败分支会把它报到这里）。两者都叫「订阅失败」会把排障带偏 —— 一条被拒的帧不是
   * 「监听没起来」。分开记：订阅那一条说 listen，帧那一条说 decode。
   *
   * cause 必须取 message：Error 的 message 不可枚举，整对象序列化出来是 {}，
   * 真实原因一个字都不剩（实测宿主控制台就是这样）。
   */
  const onListenFailure = (cause: unknown, stage: 'listen' | 'decode' = 'listen'): void => {
    reportError(
      stage === 'decode'
        ? 'agent transcript frame was rejected'
        : 'agent event subscription failed',
      {
        scope: 'agent-runtime',
        operation: stage,
        cause: cause instanceof Error ? cause.message : cause,
      },
    )
  }
  return createAgentRuntime({
    modelCatalog: options.modelCatalog,
    mcpReady: options.mcpReady,
    controlsMemory,
    permissionPosture: { read: posture.read, write: posture.write },
    thinking,
    report: reportError,
    connect: (ready) => {
      const bridge = {
        cwd: options.cwd,
        ready,
        onListenFailure,
        pickSavePath: options.pickSavePath,
      }
      return {
        session: createAgentSessionPort(bridge),
        threads: createAgentThreadBridge(bridge),
        config: createAgentSessionConfigBridge({ onListenFailure }),
        usage: createAgentSessionUsageBridge({ onListenFailure }),
        capabilities: createAgentCapabilityBridge(bridge),
      }
    },
  })
}
