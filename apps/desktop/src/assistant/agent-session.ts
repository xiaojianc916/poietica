import type { AcpAgentDescriptor } from '@poietica/agent-catalog'
import {
  acpAgentById,
  acpAgentLaunch,
  acpAgents,
  parseAgentProviderListOutput,
} from '@poietica/agent-catalog'
import type {
  AgentCapabilityPort,
  AgentSessionPort,
  PermissionPosturePort,
  SessionConfigPort,
  ThreadPort,
} from '@poietica/agent-contract'
import { createExternalStore, createPreference, error as reportError } from '@poietica/core'
import {
  createAgentCapabilityBridge,
  createAgentCommandBridge,
  createAgentEventSource,
  createAgentSessionConfigBridge,
  createAgentThreadBridge,
  createIpcSession,
  shutdownAgent,
} from '@poietica/ipc'
import type { AgentConfigStore } from '@poietica/settings'

import { activeMcpServers } from '../plugins/plugin-runtime'
import { activeWorkspaceRoot } from '../workspace-root'

/*
 * Where the agent session port is actually built.
 *
 * The feature package declares the port and the platform package implements
 * its two halves; neither knows about the other. This file is the only place
 * they meet, which is why it lives in the app and not in either of them.
 *
 * Nothing is adapted here, and there is nothing left to adapt: the bridge the
 * platform implements is the interface the transport itself declares. The two
 * compose by identity now, not by a structural match that merely happened to
 * hold — and a name that meant two different types in two packages is gone.
 */

/*
 * 用哪一家 agent —— 整个进程唯一的答案。
 *
 * 此前这个答案有五份：会话桥、对话端口、能力表的兜底、AppShell 的方言，以及
 * 工作区接线里那个 AGENT_ID，五处各自去读注册表的第一行。而用户在设置里选的
 * 那一家写在 agents.json 的 defaultAgentId 上 —— 落盘、校验、自愈一应俱全，却
 * 没有任何一条对话路径读过它。今天两者恒等，只因为名单里只有一家；名单长到两
 * 家的那天，会话起 A、方言说 B，而屏幕上一声不吭。
 *
 * 组合根在启动时认下它，设置页改完之后再认一次。名单里查不到就回落到第一家：
 * 那是一份坏掉的配置，不是一个该让应用打不开的理由。
 */
let chosenAgentId: string | undefined

/*
 * 订阅那圈样板出自 @poietica/core：一个 listener 集合、一次遍历通知、一对
 * add/delete。留在这里的只有"值是什么、什么时候换" —— 那部分本来就归本模块,
 * 也是 createExternalStore 刻意不接管的部分。
 */
const agent = createExternalStore<string | undefined>({ read: () => chosenAgentId })

/** 名单里的那一家；查不到说明配置指向了一份不存在的档案。 */
export function agentFor(agentId: string | undefined): AcpAgentDescriptor {
  return (agentId === undefined ? undefined : acpAgentById(agentId)) ?? acpAgents()[0]
}

export function currentAgent(): AcpAgentDescriptor {
  return agentFor(agent.read())
}

export function currentAgentId(): string {
  return agentFor(agent.read()).id
}

/** 组合根说了算：落盘的配置读回来是什么，就是什么。 */
export function adoptAgent(agentId: string): void {
  if (agentId === chosenAgentId) {
    return
  }

  chosenAgentId = agentId
  agent.notify()
}

/** 听"换了一家"。返回退订。 */
export const subscribeAgent = agent.subscribe

/*
 * 订阅装不上是同一类事故：帧流、会话设置、锚会话表三条通道共用一种报法。
 *
 * 听不见不是致命错 —— 下一次显式读取仍然拿得到权威答案 —— 但它必须留下痕迹，
 * 否则一张永远不刷新的表在日志里没有任何解释。
 */
function noteListenFailure(cause: unknown): void {
  reportError('agent event subscription failed', {
    scope: 'agent-session',
    operation: 'listen',
    cause,
  })
}

/*
 * 改会话设置的那一路，整个进程一份。
 *
 * 它是无状态的：一次改动就是一次往返，agent 把改完的整张表报回来。没有读，所以
 * 这里没有任何缓存可言，一个实例够了；每次渲染新建一个对象只会让下游的依赖数组
 * 每帧都变。
 */
/*
 * 批准方式的持久意图，一个进程一份。
 *
 * ACP 的 mode 是会话级活状态：session/set_config_option 按 sessionId 寻址，而
 * session/new 不带配置参数，所以"重启之后还是我上次选的那个"协议自己答不出来。
 * agent 那一侧持久的是它 config.toml 里的 default_permission_mode，而那是 agent
 * 的资产；客户端这一侧的对应位置就是这一格偏好。
 *
 * 走 @poietica/core 的偏好管线 —— 这个仓库唯一允许触碰 Web Storage 的入口（见
 * tools/architecture/rules.config.mjs 的 client-preferences-single-pipeline）。
 * 它必须同步读得到：输入框那颗胶囊与第一张控件表同帧上屏。
 */
const posture = createPreference<string | undefined>({
  key: 'poietica.permission-posture',
  fallback: undefined,
  decode: (raw) => raw,
  encode: (value) => value ?? null,
  onFailure: (failure) => {
    reportError('permission posture preference failed', {
      scope: 'agent-session',
      operation: failure.stage,
      cause: failure.cause,
    })
  },
})

/*
 * 端口的两半就是这一格偏好的两半：读上次选的，写这次选的。
 *
 * 域层只认这个接口，不认它落在哪里 —— 两台 store 因此共用同一个持久意图，而不是
 * 各自去摸一个全局单例，单测也不需要一个 Storage。
 */
const permissionPosture: PermissionPosturePort = {
  read: posture.read,
  write: (value) => {
    posture.write(value)
  },
}

export function desktopPermissionPosture(): PermissionPosturePort {
  return permissionPosture
}

let sessionConfig: SessionConfigPort | undefined

export function desktopSessionConfig(): SessionConfigPort {
  sessionConfig ??= createAgentSessionConfigBridge({ onListenFailure: noteListenFailure })

  return sessionConfig
}

/*
 * "这一家 agent 提供哪些可调项、每一项此刻生效什么"，一个 agent 一份。
 *
 * 一张表一个产地：锚会话。模型、模式、推理档位都在它报的那张表里，而这三件事本来
 * 就互相决定 —— ACP 的 session/new 与 set_config 一律回整张表，理由逐字是 changing
 * one may add or remove another（见 @poietica/agent-contract 的 config.ts）。
 *
 * 此前这里把两个产地缝成一张表：模型清单来自 agent 的 CLI（provider list --json,
 * 读 config.toml 的静态目录），模式与推理档位来自锚会话。锚会话是按 default_model
 * 开的，所以那两项描述的是 default_model 那个模型，而同一个数组里的"当前模型"取自
 * 目录 —— 两个值只是碰巧可能相等。换模型时档位不跟着换、重启后档位取决于上次退出
 * 前写下的 default_model，都是那一行的直接后果。
 *
 * CLI 只剩一件事：播种。锚会话要有一个可用的 default_model 才开得起来（上游
 * hasUsableConfiguredDefaultModel 第一行就是缺席即 false），而全新安装时那一格是
 * 空的 —— 于是先按目录挑一个写进配置，再问锚会话。这不是第二条读取路径：它一个
 * 进程里最多发生一次，也不产出任何画在屏幕上的东西。
 *
 * 按 store 与 agentId 一起记住那个对象。端口的身份就是能力表判断"换没换一家"的
 * 依据，而这个对象把 store 封进了闭包 —— 键少一个输入，换一份配置就会拿回上一份
 * 的端口，而它写的还是上一份配置。
 */
const capabilities = new WeakMap<AgentConfigStore, Map<string, AgentCapabilityPort>>()

export function desktopAgentCapabilities(
  store: AgentConfigStore,
  agentId: string,
): AgentCapabilityPort {
  let byAgent = capabilities.get(store)

  if (byAgent === undefined) {
    byAgent = new Map()
    capabilities.set(store, byAgent)
  }

  const held = byAgent.get(agentId)

  if (held !== undefined) {
    return held
  }

  const anchor = createAgentCapabilityBridge({
    launch: () => acpAgentLaunch(agentFor(agentId)),
    onListenFailure: noteListenFailure,
  })

  const source: AgentCapabilityPort = {
    read: async () => {
      await seedDefaultModel(store, agentId)

      return anchor.read()
    },

    /*
     * 换模型要落盘，而落盘在切换之前。
     *
     * default_model 是这件事唯一的家，写它的那条原生命令本身就是校验：别名必须在
     * 配置里、对应 provider 必须有可用的凭据。先写、写成了再切，失手时锚会话与屏幕
     * 都还停在原处；反过来的顺序会让屏幕换到一个下次启动就消失的模型，而人以为自己
     * 改的是一个偏好。
     */
    select: async (control, value) => {
      if (control.purpose === 'model') {
        await store.saveDefaultModel(agentId, value)
      }

      return anchor.select(control, value)
    },

    /* 这一层只在 read 与 select 前后落盘 default_model，听不改，原样转发。 */
    subscribe: anchor.subscribe,
  }

  byAgent.set(agentId, source)

  return source
}

/*
 * 配置里还没有 default_model 时，按 agent 自己的目录挑一个写进去。
 *
 * 挑第一个是稳定的：快照在 provider-state 里按 provider id 排过序。它只是个起点，
 * 不是偏好 —— 也是"密钥配好了、模型也列出来了，一发消息却说 Authentication
 * required"的根治：缺 default_model 会让配置文件里的 api_key 整条不算数。
 */
async function seedDefaultModel(store: AgentConfigStore, agentId: string): Promise<void> {
  if ((await store.loadDefaultModel(agentId)) !== null) {
    return
  }

  const first = (await readModelAliases(store, agentId))[0]

  if (first === undefined) {
    return
  }

  await store.saveDefaultModel(agentId, first)
}

/** 这一家配了哪些模型。没配凭据的那一家不列 —— 挑一个必定失败的没有意义。 */
async function readModelAliases(
  store: AgentConfigStore,
  agentId: string,
): Promise<readonly string[]> {
  /* 问什么、哪个 id 是环境变量合成的保留条目，都写在 agent 的档案里。 */
  const descriptor = acpAgentById(agentId)
  const listArgs = descriptor?.providerListArgs

  if (descriptor === undefined || listArgs === undefined) {
    throw new Error(`${agentId} 没有声明查询模型清单的子命令。`)
  }

  const outcome = await store.execCli({ agentId, args: [...listArgs] })

  /*
   * 非零退出时把 agent 自己的 stderr 原样上屏。config.toml 坏了的时候它说得比我们
   * 清楚 —— 连怎么修都告诉你 —— 转述一遍只会丢信息。
   */
  if (outcome.status !== 0) {
    const said = outcome.stderr.trim()

    throw new Error(said.length === 0 ? `agent 以 ${outcome.status} 退出。` : said)
  }

  const snapshot = parseAgentProviderListOutput(outcome.stdout, descriptor.syntheticProviderId)

  return snapshot.providers
    .filter((provider) => provider.configured)
    .flatMap((provider) => provider.models.map((model) => model.alias))
}

export interface DesktopAgentSession {
  readonly port: AgentSessionPort
  /** Ends the session and lets the agent process exit. */
  readonly dispose: () => Promise<void>
}

export function createDesktopAgentSession(): DesktopAgentSession {
  const port = createIpcSession({
    bridge: createAgentCommandBridge({
      cwd: activeWorkspaceRoot,
      launch: () => acpAgentLaunch(currentAgent()),
      mcpServers: activeMcpServers,
    }),

    source: createAgentEventSource({ onListenFailure: noteListenFailure }),
  })

  return {
    port,

    dispose: async () => {
      try {
        await shutdownAgent()
      } catch (cause: unknown) {
        // A window is closing. A failed shutdown is worth a log and nothing
        // more; the process is going away regardless.
        reportError('agent shutdown failed', {
          scope: 'agent-session',
          operation: 'shutdown',
          cause,
        })
      }
    },
  }
}

/** The desktop implementation of the conversation port. */
let threads: ThreadPort | undefined

export function desktopThreads(): ThreadPort {
  threads ??= buildThreadPort()

  return threads
}

/*
 * 一个进程一座桥。
 *
 * 桥是无状态的问答口，可它握着一条 IPC 通道：每次调用都新建一座，就等于每个
 * 读会话列表的地方各自问一遍，同一份列表被读了不止一次。
 */
function buildThreadPort(): ThreadPort {
  const bridge = createAgentThreadBridge({
    cwd: activeWorkspaceRoot,
    launch: () => acpAgentLaunch(currentAgent()),
    mcpServers: activeMcpServers,
  })

  /*
   * 原样交出去，这也是这个文件开头就声明过的事（Nothing is adapted here）。
   *
   * titleSource 在两边现在是同一个三值闭集，没有一个字段需要改名或改档。此前
   * 这里对每一行跑一次收窄、再把整张表 spread 重建一遍 —— 那次收窄之所以存在,
   * 只是因为绑定把一个闭集写成了 string，而它认的第四档平台早就不发了。
   */
  return bridge
}
