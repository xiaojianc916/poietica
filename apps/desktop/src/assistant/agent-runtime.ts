import type {
  AgentCapabilityPort,
  AgentSessionPort,
  OpenedThread,
  PermissionPosturePort,
  SessionConfigControl,
  SessionConfigMemoryPort,
  SessionConfigPort,
  SessionUsagePort,
  ThreadPort,
} from '@poietica/conversation'
import type { ModelCatalogStore } from '@poietica/settings'
import type { ThinkingPreference } from './thinking-preference'

type ModelCatalogAccess = Pick<
  ModelCatalogStore,
  'synchronizeMetadata' | 'refresh' | 'getSnapshot' | 'mutate'
>

export interface DesktopAgentRuntime {
  readonly session: AgentSessionPort
  readonly threads: ThreadPort
  readonly sessionConfig: SessionConfigPort
  readonly sessionUsage: SessionUsagePort
  readonly permissionPosture: PermissionPosturePort
  readonly controlsMemory: SessionConfigMemoryPort
  readonly capabilities: () => AgentCapabilityPort
  readonly dispose: () => Promise<void>
}

export interface AgentRuntimeChannels {
  readonly session: AgentSessionPort
  readonly threads: ThreadPort
  readonly config: SessionConfigPort
  readonly usage: SessionUsagePort
  readonly capabilities: AgentCapabilityPort
}

export interface AgentRuntimeDependencies {
  readonly agentId: string
  readonly modelCatalog: ModelCatalogAccess
  readonly mcpReady: () => Promise<void>
  readonly controlsMemory: SessionConfigMemoryPort
  readonly permissionPosture: PermissionPosturePort
  readonly thinking: ThinkingPreference
  readonly connect: (prepareAgent: () => Promise<string>) => AgentRuntimeChannels
  readonly report: (
    message: string,
    context: { scope: string; operation: string; cause: unknown },
  ) => void
}

export function createAgentRuntime(options: AgentRuntimeDependencies): DesktopAgentRuntime {
  let disposed = false
  let metadataReady: Promise<void> | null = null
  const requireActive = (): void => {
    if (disposed) {
      throw new DOMException('Agent runtime stopped.', 'AbortError')
    }
  }
  const ensureModelMetadata = async (): Promise<void> => {
    const pending = metadataReady ?? options.modelCatalog.synchronizeMetadata()
    metadataReady = pending
    try {
      await pending
    } catch (cause: unknown) {
      if (metadataReady === pending) {
        metadataReady = null
      }
      if (!disposed) {
        options.report('model metadata synchronization failed', {
          scope: 'agent-runtime',
          operation: 'synchronize-model-metadata',
          cause,
        })
      }
    }
  }
  /*
   * 起 agent 只等一件事：受控 home 里的 mcp.json 已经对齐。
   *
   * 那是 agent 进程启动时读一次的文件，排在 spawn 之前是必须的。
   *
   * 模型元数据不在这里等。它是一趟目录快照加一次 patchConfig 的写，产出的是模型
   * 的显示名与上下文上限 —— 没有它，选择器照样报得出这一刻在用哪个模型、哪些档位。
   * 把它排进 launch，等于让第一张控件表去等一次与它无关的写盘往返；那一趟照样跑，
   * 只是不再挡在会话前面（见下面 seedDefaultModel 的同一条理由）。
   */
  const prepareAgent = async (): Promise<string> => {
    requireActive()
    await options.mcpReady()
    requireActive()
    void ensureModelMetadata()
    return options.agentId
  }
  const channels = options.connect(prepareAgent)
  const { config, capabilities: anchor } = channels
  const alignThinking = async (
    controls: readonly SessionConfigControl[],
    select: (
      control: SessionConfigControl,
      value: string,
    ) => Promise<readonly SessionConfigControl[]>,
  ): Promise<readonly SessionConfigControl[]> => {
    requireActive()
    const preferred = options.thinking.selection(options.agentId, controls)
    if (preferred === undefined || preferred.control.current === preferred.value) {
      return controls
    }
    const aligned = await select(preferred.control, preferred.value)
    requireActive()
    return aligned
  }
  const commitSelection = async (
    controls: readonly SessionConfigControl[],
    controlId: string,
    value: string,
    select: (
      control: SessionConfigControl,
      value: string,
    ) => Promise<readonly SessionConfigControl[]>,
  ): Promise<readonly SessionConfigControl[]> => {
    requireActive()
    const accepted = controls.find((control) => control.id === controlId)
    if (accepted?.current !== value) {
      return controls
    }
    if (accepted.purpose === 'model') {
      await options.modelCatalog.mutate({ kind: 'setDefault', modelId: value })
      requireActive()
    }
    options.thinking.remember(options.agentId, controls, controlId, value)
    return alignThinking(controls, select)
  }
  let seeded = false
  const seedDefaultModel = (): void => {
    if (disposed || seeded) {
      return
    }
    seeded = true
    // A failed optional seed must not turn a capability read into a connection failure.
    void firstUsableModel(options.modelCatalog)
      .then(async (alias) => {
        if (!disposed && alias !== undefined) {
          await options.modelCatalog.mutate({ kind: 'setDefault', modelId: alias })
        }
      })
      .catch((cause: unknown) => {
        if (disposed) {
          return
        }
        seeded = false
        options.report('default model seeding failed', {
          scope: 'agent-runtime',
          operation: 'seed-default-model',
          cause,
        })
      })
  }
  const sessionConfig: SessionConfigPort = {
    subscribe: config.subscribe,
    select: async (threadId, configId, value, input) => {
      requireActive()
      const controls = await config.select(threadId, configId, value, input)
      return commitSelection(controls, configId, value, (control, preferred) =>
        config.select(threadId, control.id, preferred),
      )
    },
  }
  const alignOpened = async (opened: OpenedThread): Promise<OpenedThread> => {
    const selectors = await alignThinking(opened.selectors, (control, value) =>
      config.select(opened.thread.threadId, control.id, value),
    )
    return selectors === opened.selectors ? opened : { ...opened, selectors }
  }
  const threads: ThreadPort = {
    ...channels.threads,
    create: async (threadId, workspaceRoot) => {
      requireActive()
      return alignOpened(await channels.threads.create(threadId, workspaceRoot))
    },
    open: async (threadId) => {
      requireActive()
      return alignOpened(await channels.threads.open(threadId))
    },
  }
  const capabilityPort: AgentCapabilityPort = {
    read: async () => {
      requireActive()
      seedDefaultModel()
      return alignThinking(await anchor.read(), (control, value) => anchor.select(control, value))
    },
    select: async (control, value) => {
      requireActive()
      return commitSelection(
        await anchor.select(control, value),
        control.id,
        value,
        (candidate, preferred) => anchor.select(candidate, preferred),
      )
    },
    readToolkit: anchor.readToolkit,
    subscribe: anchor.subscribe,
  }
  return {
    session: channels.session,
    threads,
    sessionConfig,
    sessionUsage: channels.usage,
    permissionPosture: options.permissionPosture,
    controlsMemory: options.controlsMemory,
    capabilities: () => capabilityPort,
    dispose() {
      disposed = true
      // Native shutdown owns the agent process; this owner stops renderer policy effects.
      return Promise.resolve()
    },
  }
}

async function firstUsableModel(catalog: ModelCatalogAccess): Promise<string | undefined> {
  await catalog.refresh()

  const { data, error } = catalog.getSnapshot()

  if (data === null) {
    throw new Error(error ?? '模型目录读取失败。')
  }

  if (data.defaultModel !== null) {
    return undefined
  }

  const keyed = new Set(
    data.providers.filter((provider) => provider.hasApiKey).map((provider) => provider.id),
  )

  return data.models.find((model) => keyed.has(model.provider))?.model
}
