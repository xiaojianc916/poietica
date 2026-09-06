import { agent } from '@poietica/agent-catalog'
import { createPreference } from '@poietica/external-store'
import {
  type AgentBridgeOptions,
  createAgentCapabilityBridge,
  createAgentSessionConfigBridge,
  createAgentSessionPort,
  createAgentSessionUsageBridge,
  createAgentThreadBridge,
} from '@poietica/native-bridge/conversation'
import { error as reportError } from '@poietica/problem'
import type { ModelCatalogStore } from '@poietica/settings'
import { createAgentRuntime, type DesktopAgentRuntime } from '../assistant/agent-runtime'
import { createThinkingPreference } from '../assistant/thinking-preference'

interface DesktopAgentRuntimeOptions {
  readonly modelCatalog: ModelCatalogStore
  readonly cwd: NonNullable<AgentBridgeOptions['cwd']>
  readonly mcpReady: () => Promise<void>
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
  const onListenFailure = (cause: unknown): void => {
    reportError('agent event subscription failed', {
      scope: 'agent-runtime',
      operation: 'listen',
      cause,
    })
  }
  return createAgentRuntime({
    agentId: agent.id,
    modelCatalog: options.modelCatalog,
    mcpReady: options.mcpReady,
    permissionPosture: { read: posture.read, write: posture.write },
    thinking,
    report: reportError,
    connect: (prepareAgent) => {
      const launch: AgentBridgeOptions['launch'] = async () => ({ agentId: await prepareAgent() })
      const bridge = { cwd: options.cwd, launch, onListenFailure }
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
