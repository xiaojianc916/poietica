import type { AgentDescriptor } from '@poietica/agent-catalog'
import {
  agentById,
  agentLaunch,
  agentRoster,
  parseAgentProviderListOutput,
} from '@poietica/agent-catalog'
import type {
  AgentCapabilityPort,
  AgentSessionPort,
  PermissionPosturePort,
  SessionConfigPort,
  SessionUsagePort,
  ThreadPort,
} from '@poietica/agent-contract'
import { createExternalStore, createPreference, error as reportError } from '@poietica/core'
import {
  type AgentBridgeOptions,
  createAgentCapabilityBridge,
  createAgentCommandBridge,
  createAgentEventSource,
  createAgentSessionConfigBridge,
  createAgentSessionUsageBridge,
  createAgentThreadBridge,
  createIpcSession,
  shutdownAgent,
} from '@poietica/ipc'
import type { AgentConfigStore } from '@poietica/settings'

export interface DesktopAgentRuntimeOptions {
  readonly config: AgentConfigStore
  readonly cwd: NonNullable<AgentBridgeOptions['cwd']>
  readonly mcpServers: NonNullable<AgentBridgeOptions['mcpServers']>
  readonly onSelectionFailure: (cause: unknown) => void
  readonly onSelectionReady: () => void
}

export interface DesktopAgentRuntime {
  readonly session: AgentSessionPort
  readonly threads: ThreadPort
  readonly sessionConfig: SessionConfigPort
  readonly sessionUsage: SessionUsagePort
  readonly permissionPosture: PermissionPosturePort
  readonly getAgentId: () => string
  readonly subscribeAgent: (listener: () => void) => () => void
  readonly descriptor: (agentId: string) => AgentDescriptor
  readonly capabilities: (agentId: string) => AgentCapabilityPort
  readonly dispose: () => Promise<void>
}

function requireAgent(agentId: string): AgentDescriptor {
  const descriptor = agentById(agentId)

  if (descriptor === undefined) {
    throw new Error(`Agent profile "${agentId}" is not registered.`)
  }

  return descriptor
}

function noteListenFailure(cause: unknown): void {
  reportError('agent event subscription failed', {
    scope: 'agent-runtime',
    operation: 'listen',
    cause,
  })
}

export function createDesktopAgentRuntime(
  options: DesktopAgentRuntimeOptions,
): DesktopAgentRuntime {
  const fallback = agentRoster()[0]

  if (fallback === undefined) {
    throw new Error('At least one Agent profile must be registered.')
  }

  let selected = fallback
  let selectionResolved = false
  let selectionFailure: unknown
  let generation = 0
  let disposed = false
  let pending: Promise<void> = Promise.resolve()

  const selection = createExternalStore<string>({ read: () => selected.id })

  const reloadSelection = (): void => {
    const mine = generation + 1
    generation = mine

    pending = options.config
      .load()
      .then((snapshot) => {
        if (disposed || generation !== mine) {
          return
        }

        const next = requireAgent(snapshot.defaultAgentId)
        const changed = next.id !== selected.id

        selected = next
        selectionResolved = true
        selectionFailure = undefined
        options.onSelectionReady()

        if (changed) {
          selection.notify()
        }
      })
      .catch((cause: unknown) => {
        if (disposed || generation !== mine) {
          return
        }

        selectionResolved = false
        selectionFailure = cause
        options.onSelectionFailure(cause)
      })
  }

  reloadSelection()
  const stopConfig = options.config.subscribeConfigChanged(reloadSelection)

  const selectedAgent = async (): Promise<AgentDescriptor> => {
    for (;;) {
      const observed = pending
      await observed

      if (observed === pending) {
        break
      }
    }

    if (!selectionResolved) {
      throw new Error('The selected Agent profile could not be loaded.', {
        cause: selectionFailure,
      })
    }

    return selected
  }

  const launchSelected = async () => agentLaunch(await selectedAgent())

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

  const permissionPosture: PermissionPosturePort = {
    read: posture.read,
    write: posture.write,
  }

  const sessionConfig = createAgentSessionConfigBridge({ onListenFailure: noteListenFailure })

  const sessionUsage = createAgentSessionUsageBridge({ onListenFailure: noteListenFailure })

  const threads = createAgentThreadBridge({
    cwd: options.cwd,
    launch: launchSelected,
    mcpServers: options.mcpServers,
  })

  const session = createIpcSession({
    bridge: createAgentCommandBridge({
      cwd: options.cwd,
      launch: launchSelected,
      mcpServers: options.mcpServers,
    }),
    source: createAgentEventSource({ onListenFailure: noteListenFailure }),
  })

  const capabilityPorts = new Map<string, AgentCapabilityPort>()

  const capabilities = (agentId: string): AgentCapabilityPort => {
    const held = capabilityPorts.get(agentId)

    if (held !== undefined) {
      return held
    }

    const currentAgent = async (): Promise<AgentDescriptor> => {
      const current = await selectedAgent()

      if (current.id !== agentId) {
        throw new Error('Agent selection changed before the capability request completed.')
      }

      return current
    }

    const anchor = createAgentCapabilityBridge({
      cwd: options.cwd,
      launch: async () => agentLaunch(await currentAgent()),
      onListenFailure: noteListenFailure,
    })

    const source: AgentCapabilityPort = {
      read: async () => {
        await currentAgent()
        await seedDefaultModel(options.config, agentId)
        return anchor.read()
      },
      select: async (control, value) => {
        await currentAgent()

        if (control.purpose === 'model') {
          await options.config.saveDefaultModel(agentId, value)
        }

        return anchor.select(control, value)
      },
      subscribe: anchor.subscribe,
    }

    capabilityPorts.set(agentId, source)
    return source
  }

  return {
    session,
    threads,
    sessionConfig,
    sessionUsage,
    permissionPosture,
    getAgentId: selection.read,
    subscribeAgent: selection.subscribe,
    descriptor: requireAgent,
    capabilities,
    async dispose() {
      if (disposed) {
        return
      }

      disposed = true
      generation += 1
      stopConfig()
      await pending

      try {
        await shutdownAgent()
      } catch (cause: unknown) {
        reportError('agent shutdown failed', {
          scope: 'agent-runtime',
          operation: 'shutdown',
          cause,
        })
      }
    },
  }
}

async function seedDefaultModel(store: AgentConfigStore, agentId: string): Promise<void> {
  if ((await store.loadDefaultModel(agentId)) !== null) {
    return
  }

  const first = (await readModelAliases(store, agentId))[0]

  if (first !== undefined) {
    await store.saveDefaultModel(agentId, first)
  }
}

async function readModelAliases(
  store: AgentConfigStore,
  agentId: string,
): Promise<readonly string[]> {
  const descriptor = requireAgent(agentId)
  const listArgs = descriptor.providerListArgs

  if (listArgs === undefined) {
    throw new Error(`${agentId} 没有声明查询模型清单的子命令。`)
  }

  const outcome = await store.execCli({ agentId, args: [...listArgs] })

  if (outcome.status !== 0) {
    const said = outcome.stderr.trim()
    throw new Error(said.length === 0 ? `agent 以 ${outcome.status} 退出。` : said)
  }

  const snapshot = parseAgentProviderListOutput(outcome.stdout, descriptor.syntheticProviderId)

  return snapshot.providers
    .filter((provider) => provider.configured)
    .flatMap((provider) => provider.models.map((model) => model.alias))
}
