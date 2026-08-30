import type { AgentDescriptor } from '@poietica/agent-catalog'
import { agentById, agentRoster, parseAgentProviderListOutput } from '@poietica/agent-catalog'
import type {
  AgentCapabilityPort,
  AgentSessionPort,
  OpenedThread,
  PermissionPosturePort,
  SessionConfigControl,
  SessionConfigPort,
  SessionUsagePort,
  ThreadPort,
} from '@poietica/conversation'
import { createExternalStore, createPreference } from '@poietica/external-store'
import {
  type AgentBridgeOptions,
  createAgentCapabilityBridge,
  createAgentSessionConfigBridge,
  createAgentSessionPort,
  createAgentSessionUsageBridge,
  createAgentThreadBridge,
  createAgentToolkitReader,
  shutdownAgent,
} from '@poietica/native-bridge'
import { error as reportError } from '@poietica/problem'
import type { AgentConfigStore } from '@poietica/settings'
import { hostedMcpServersReady } from './plugin-runtime'
import { createThinkingPreference } from './thinking-preference'

interface DesktopAgentRuntimeOptions {
  readonly config: AgentConfigStore
  readonly cwd: NonNullable<AgentBridgeOptions['cwd']>
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
    /* 等已发出的那一趟落地就够。自旋等「没有新一趟」会被连续的配置变更饿死。 */
    await pending

    if (!selectionResolved) {
      throw new Error('The selected Agent profile could not be loaded.', {
        cause: selectionFailure,
      })
    }

    return selected
  }

  /*
   * 拉起 agent 之前先等 mcp.json 对齐到本次启动的端口：kap 在进程起来那一刻读它。
   * 所有会走到 ensure_session 的桥都经过这里，所以这一处就是全部。
   */
  const launchSelected = async () => {
    await hostedMcpServersReady

    return { agentId: (await selectedAgent()).id }
  }

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

  const thinking = createThinkingPreference((failure) => {
    reportError('Thinking preference failed', {
      scope: 'agent-runtime',
      operation: failure.stage,
      cause: failure.cause,
    })
  })

  const sessionConfigBridge = createAgentSessionConfigBridge({
    onListenFailure: noteListenFailure,
  })

  const alignThinking = async (
    agentId: string,
    controls: readonly SessionConfigControl[],
    select: (
      control: SessionConfigControl,
      value: string,
    ) => Promise<readonly SessionConfigControl[]>,
  ): Promise<readonly SessionConfigControl[]> => {
    const preferred = thinking.selection(agentId, controls)

    return preferred === undefined || preferred.control.current === preferred.value
      ? controls
      : await select(preferred.control, preferred.value)
  }

  /*
   * 一次改动生效之后的三件事，一处发生：模型别名落进 default_model、记下这一档
   * Thinking、让新模型的档位收敛到用户的持久选择。
   *
   * 归属在写之前重验：往返期间设置页可能换过 agent，那时这个别名不属于现在这一家。
   * 锚会话与对话内两条路共用这一条落账，不再各写一遍。
   */
  const commitSelection = async (
    agentId: string,
    controls: readonly SessionConfigControl[],
    controlId: string,
    value: string,
    select: (
      control: SessionConfigControl,
      value: string,
    ) => Promise<readonly SessionConfigControl[]>,
  ): Promise<readonly SessionConfigControl[]> => {
    const accepted = controls.find((control) => control.id === controlId)

    if (accepted?.current !== value) {
      return controls
    }

    if ((await selectedAgent()).id !== agentId) {
      throw new Error('Agent selection changed before the configuration change completed.')
    }

    if (accepted.purpose === 'model') {
      await options.config.saveDefaultModel(agentId, value)
    }

    thinking.remember(agentId, controls, controlId, value)

    return alignThinking(agentId, controls, select)
  }

  /*
   * 没设过默认模型时补一个，每家一次，且不挡住读表。
   *
   * 补种是一次配置写入，读表是一次会话读取：把前者的失败算进后者，一个坏掉的
   * config.toml 会让整张选择器表变成「没连上 agent」。失败不算补过，下次再试。
   */
  const seeded = new Set<string>()

  const seedDefaultModel = (agentId: string): void => {
    if (seeded.has(agentId)) {
      return
    }

    seeded.add(agentId)

    void firstUsableModel(options.config, agentId)
      .then(async (alias) => {
        if (alias !== undefined) {
          await options.config.saveDefaultModel(agentId, alias)
        }
      })
      .catch((cause: unknown) => {
        seeded.delete(agentId)

        reportError('default model seeding failed', {
          scope: 'agent-runtime',
          operation: 'seed-default-model',
          cause,
        })
      })
  }

  const sessionConfig: SessionConfigPort = {
    subscribe: sessionConfigBridge.subscribe,
    select: async (threadId, configId, value, input) => {
      const agentId = (await selectedAgent()).id
      const controls = await sessionConfigBridge.select(threadId, configId, value, input)

      return commitSelection(agentId, controls, configId, value, (control, preferred) =>
        sessionConfigBridge.select(threadId, control.id, preferred),
      )
    },
  }

  const sessionUsage = createAgentSessionUsageBridge({ onListenFailure: noteListenFailure })

  const readToolkit = createAgentToolkitReader({ cwd: options.cwd, launch: launchSelected })

  const threadBridge = createAgentThreadBridge({
    cwd: options.cwd,
    launch: launchSelected,
  })

  const alignOpened = async (opened: OpenedThread): Promise<OpenedThread> => {
    const agent = await selectedAgent()
    const selectors = await alignThinking(agent.id, opened.selectors, (control, value) =>
      sessionConfigBridge.select(opened.thread.threadId, control.id, value),
    )

    return selectors === opened.selectors ? opened : { ...opened, selectors }
  }

  const threads: ThreadPort = {
    ...threadBridge,
    create: async (threadId, workspaceRoot) =>
      alignOpened(await threadBridge.create(threadId, workspaceRoot)),
    open: async (threadId) => alignOpened(await threadBridge.open(threadId)),
  }

  const session = createAgentSessionPort({
    cwd: options.cwd,
    launch: launchSelected,
    onListenFailure: noteListenFailure,
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
      launch: async () => {
        await hostedMcpServersReady

        return { agentId: (await currentAgent()).id }
      },
      onListenFailure: noteListenFailure,
    })

    const source: AgentCapabilityPort = {
      read: async () => {
        await currentAgent()
        seedDefaultModel(agentId)

        return alignThinking(agentId, await anchor.read(), (control, value) =>
          anchor.select(control, value),
        )
      },
      select: async (control, value) => {
        await currentAgent()

        /* select 的答复就是权威表，不再回读：回读拿到的是这次写入之前的那一张。 */
        return commitSelection(
          agentId,
          await anchor.select(control, value),
          control.id,
          value,
          (candidate, preferred) => anchor.select(candidate, preferred),
        )
      },
      readToolkit: async (threadId) => {
        await currentAgent()
        return readToolkit(threadId)
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

/**
 * 这家 agent 报出的第一个可用别名。
 *
 * 已经设过默认模型、或档案没声明清单查询，就没有答案：那一家的模型由它自己的
 * 运行时决定，问不了不是故障。
 */
async function firstUsableModel(
  store: AgentConfigStore,
  agentId: string,
): Promise<string | undefined> {
  const descriptor = requireAgent(agentId)
  const listArgs = descriptor.providerListArgs

  if (listArgs === undefined || (await store.loadDefaultModel(agentId)) !== null) {
    return undefined
  }

  const outcome = await store.execCli({ agentId, args: [...listArgs] })

  if (outcome.status !== 0) {
    const said = outcome.stderr.trim()

    throw new Error(said.length === 0 ? `agent 以 ${outcome.status} 退出。` : said)
  }

  return parseAgentProviderListOutput(outcome.stdout, descriptor.syntheticProviderId)
    .providers.filter((provider) => provider.configured)
    .flatMap((provider) => provider.models.map((model) => model.alias))[0]
}
