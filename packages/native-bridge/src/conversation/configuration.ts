import { commands } from '@poietica/contract'
import type {
  AgentCapabilityPort,
  SessionConfigPort,
  SessionUsagePort,
} from '@poietica/conversation'
import { throughIpc } from '../ipc-error'
import { type AgentEventSourceOptions, subscribeToSessionEvent } from './event-subscription'
import type { AgentBridgeOptions } from './launch-contract'
import { controlOf, goalOf } from './selectors'
import { createAgentToolkitReader } from './toolkit'

export function createAgentSessionConfigBridge({
  onListenFailure,
}: AgentEventSourceOptions = {}): SessionConfigPort {
  return {
    select: async (threadId, configId, value, input) => {
      const offered = await throughIpc(() =>
        commands.agentSetConfigOption({
          threadId,
          configId,
          value,
          input: input ?? null,
        }),
      )

      return offered.map(controlOf)
    },

    /* 线上叫 selectors，端口叫 controls；改名只发生在这一层。 */
    subscribe: (handler) =>
      subscribeToSessionEvent(
        'selectors',
        (payload) => {
          handler({
            sessionId: payload.sessionId,
            controls: payload.selectors.map(controlOf),
            goal: goalOf(payload.goal),
          })
        },
        onListenFailure,
      ),
  }
}
export function createAgentSessionUsageBridge({
  onListenFailure,
}: AgentEventSourceOptions = {}): SessionUsagePort {
  return {
    subscribe: (handler) =>
      subscribeToSessionEvent(
        'usage',
        (payload) => {
          handler({ sessionId: payload.sessionId, usage: payload.usage })
        },
        onListenFailure,
      ),
  }
}
export function createAgentCapabilityBridge({
  cwd,
  launch,
  onListenFailure,
}: AgentBridgeOptions & AgentEventSourceOptions): AgentCapabilityPort {
  return {
    read: async () => {
      const resolvedLaunch = await launch()
      const offered = await throughIpc(() =>
        commands.agentCapabilities({
          launch: resolvedLaunch,
          cwd: cwd?.() ?? null,
        }),
      )

      return offered.map(controlOf)
    },

    select: async (control, value) => {
      const offered = await throughIpc(() =>
        commands.agentSetConfigOption({
          threadId: null,
          configId: control.id,
          value,
          input: null,
        }),
      )

      return offered.map(controlOf)
    },

    /* 报文里那条会话是谁，锚会话这一侧回答不了，所以只把「变了」交出去。 */
    subscribe: (handler) =>
      subscribeToSessionEvent(
        'selectors',
        () => {
          handler()
        },
        onListenFailure,
      ),

    readToolkit: createAgentToolkitReader(cwd === undefined ? { launch } : { launch, cwd }),
  }
}
