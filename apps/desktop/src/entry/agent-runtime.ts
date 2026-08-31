import { agent, parseAgentProviderListOutput } from '@poietica/agent-catalog'
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
import { createPreference } from '@poietica/external-store'
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
}

export interface DesktopAgentRuntime {
  readonly session: AgentSessionPort
  readonly threads: ThreadPort
  readonly sessionConfig: SessionConfigPort
  readonly sessionUsage: SessionUsagePort
  readonly permissionPosture: PermissionPosturePort
  readonly capabilities: () => AgentCapabilityPort
  readonly dispose: () => Promise<void>
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
  let disposed = false

  /*
   * 拉起 agent 之前先等 mcp.json 对齐到本次启动的端口：kap 在进程起来那一刻读它。
   * 所有会走到 ensure_session 的桥都经过这里，所以这一处就是全部。
   */
  const launchAgent = async () => {
    await hostedMcpServersReady

    return { agentId: agent.id }
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
    controls: readonly SessionConfigControl[],
    select: (
      control: SessionConfigControl,
      value: string,
    ) => Promise<readonly SessionConfigControl[]>,
  ): Promise<readonly SessionConfigControl[]> => {
    const preferred = thinking.selection(agent.id, controls)

    return preferred === undefined || preferred.control.current === preferred.value
      ? controls
      : await select(preferred.control, preferred.value)
  }

  /*
   * 一次改动生效之后的三件事，一处发生：模型别名落进 default_model、记下这一档
   * Thinking、让新模型的档位收敛到用户的持久选择。
   *
   * 锚会话与对话内两条路共用这一条落账，不再各写一遍。
   */
  const commitSelection = async (
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

    if (accepted.purpose === 'model') {
      await options.config.saveDefaultModel(agent.id, value)
    }

    thinking.remember(agent.id, controls, controlId, value)

    return alignThinking(controls, select)
  }

  /*
   * 没设过默认模型时补一个，一个进程一次，且不挡住读表。
   *
   * 补种是一次配置写入，读表是一次会话读取：把前者的失败算进后者，一个坏掉的
   * config.toml 会让整张选择器表变成「没连上 agent」。失败不算补过，下次再试。
   */
  let seeded = false

  const seedDefaultModel = (): void => {
    if (seeded) {
      return
    }

    seeded = true

    void firstUsableModel(options.config)
      .then(async (alias) => {
        if (alias !== undefined) {
          await options.config.saveDefaultModel(agent.id, alias)
        }
      })
      .catch((cause: unknown) => {
        seeded = false

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
      const controls = await sessionConfigBridge.select(threadId, configId, value, input)

      return commitSelection(controls, configId, value, (control, preferred) =>
        sessionConfigBridge.select(threadId, control.id, preferred),
      )
    },
  }

  const sessionUsage = createAgentSessionUsageBridge({ onListenFailure: noteListenFailure })

  const readToolkit = createAgentToolkitReader({ cwd: options.cwd, launch: launchAgent })

  const threadBridge = createAgentThreadBridge({
    cwd: options.cwd,
    launch: launchAgent,
  })

  const alignOpened = async (opened: OpenedThread): Promise<OpenedThread> => {
    const selectors = await alignThinking(opened.selectors, (control, value) =>
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
    launch: launchAgent,
    onListenFailure: noteListenFailure,
  })

  /* 端口一个进程一份：它有身份（start() 返回退订），每次新建就多一份订阅。 */
  let capabilityPort: AgentCapabilityPort | undefined

  const capabilities = (): AgentCapabilityPort => {
    if (capabilityPort !== undefined) {
      return capabilityPort
    }

    const anchor = createAgentCapabilityBridge({
      cwd: options.cwd,
      launch: launchAgent,
      onListenFailure: noteListenFailure,
    })

    capabilityPort = {
      read: async () => {
        seedDefaultModel()

        return alignThinking(await anchor.read(), (control, value) => anchor.select(control, value))
      },
      /* select 的答复就是权威表，不再回读：回读拿到的是这次写入之前的那一张。 */
      select: async (control, value) =>
        commitSelection(
          await anchor.select(control, value),
          control.id,
          value,
          (candidate, preferred) => anchor.select(candidate, preferred),
        ),
      readToolkit,
      subscribe: anchor.subscribe,
    }

    return capabilityPort
  }

  return {
    session,
    threads,
    sessionConfig,
    sessionUsage,
    permissionPosture,
    capabilities,
    async dispose() {
      if (disposed) {
        return
      }

      disposed = true

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

/** 这家 agent 报出的第一个可用别名。已经设过默认模型就没有答案。 */
async function firstUsableModel(store: AgentConfigStore): Promise<string | undefined> {
  if ((await store.loadDefaultModel(agent.id)) !== null) {
    return undefined
  }

  const outcome = await store.execCli({
    agentId: agent.id,
    args: [...agent.providerListArgs],
  })

  if (outcome.status !== 0) {
    const said = outcome.stderr.trim()

    throw new Error(said.length === 0 ? `agent 以 ${outcome.status} 退出。` : said)
  }

  return parseAgentProviderListOutput(outcome.stdout, agent.syntheticProviderId)
    .providers.filter((provider) => provider.configured)
    .flatMap((provider) => provider.models.map((model) => model.alias))[0]
}
