import type { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import type { LoadedCustomCommand } from '@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types'
import type { loadAllMCPConfigs, shouldFilterBrowserMCPForPrelude } from '@oh-my-pi/pi-coding-agent/mcp/config'
import type { MCPManager } from '@oh-my-pi/pi-coding-agent/mcp/manager'
import type { MCPToolCache } from '@oh-my-pi/pi-coding-agent/mcp/tool-cache'
import type { AgentSession } from '@oh-my-pi/pi-coding-agent/session/agent-session'
import type { createMCPProxyTools, followMCPTools } from '@oh-my-pi/pi-coding-agent/task/executor'
import type { Logger } from '@poietica/foundation'
import { listenSetting, readSetting, type SettingsScope } from '../settings-access'

/**
 * omp 里 MCP 的那几块。由组合根动态 import 后注入：task/executor 与 sdk 互相 import，
 * 在这里静态引入会让它先于 sdk 求值（create-engine 的 ompModules 也是同一个理由）。
 */
export interface McpRuntime {
  readonly MCPManager: typeof MCPManager
  readonly MCPToolCache: typeof MCPToolCache
  readonly loadAllMCPConfigs: typeof loadAllMCPConfigs
  readonly shouldFilterBrowserMCPForPrelude: typeof shouldFilterBrowserMCPForPrelude
  readonly createMCPProxyTools: typeof createMCPProxyTools
  readonly followMCPTools: typeof followMCPTools
  /** omp 首轮等发现的预算（agent-session 的 MCP_DISCOVERY_TURN_WAIT_MS）：发现收尾时再给慢服务器这么久 */
  readonly turnWaitMs: number
}

/** 最后一个会话关掉之后，服务器再留多久（切对话、空闲驱逐、设置变更重开都落在这个窗口里） */
export const MCP_IDLE_GRACE_MS = 5 * 60_000
/** 同时留着的空闲工作区上限（按最近空闲的顺序留；超出的当场释放） */
export const MAX_IDLE_WORKSPACES = 2

export interface McpWorkspacesOptions {
  readonly runtime: McpRuntime
  /** 根设置：MCP 的开关都是用户级的，会话 overlay 只多了审批姿态 */
  readonly root: SettingsScope
  readonly authStorage: unknown
  readonly logger: Logger
  /** 连接状态有变（连上 / 断开 / 工作区释放）：端口据此重新汇总 */
  readonly onStatus: () => void
  /** 测试缝：空闲宽限期 */
  readonly idleGraceMs?: number
}

/** 会话从工作区借来的那一份：manager 交给 createAgentSession，会话建好后 attach，关掉时 release */
export interface McpLease {
  readonly manager: MCPManager
  /** 会话建好后调用一次：挂上工具跟随、提示命令，必要时启动这个工作区的首次发现。不抛错 */
  attach(session: AgentSession): Promise<void>
  /** 归还（幂等）；attach 过的会话 dispose 时会自动调用 */
  release(): void
}

interface Workspace {
  readonly cwd: string
  readonly fingerprint: string
  readonly manager: MCPManager
  readonly sessions: Set<AgentSession>
  refs: number
  /** 首次发现（含首轮等待）；null = 还没有会话 attach 过 */
  discovery: Promise<void> | null
  settled: boolean
  idleSince: number
  idleTimer: ReturnType<typeof setTimeout> | null
  /** 配置变了：不再借给新会话，最后一个会话关掉就释放 */
  retired: boolean
  disposed: boolean
  readonly debounce: Map<string, ReturnType<typeof setTimeout>>
  readonly unsubscribe: () => void
}

/**
 * MCP 服务器归工作区（omp 知识 #22）。
 *
 * omp 的 createAgentSession 在 `hasUI: true` 且不给 `mcpManager` 时，会给**每个会话**新建一个 MCPManager、
 * 在后台拉起全部服务器，会话 dispose 时再全部杀掉。服务器的配置是用户级 + 项目级（`.mcp.json`）、
 * roots 报的是 cwd —— 它们是工作区的资源；而 Poietica 的会话随线程表面挂载 / 卸载开关，
 * 于是每切一次对话就把全部 MCP 进程杀掉重启一遍。
 *
 * 这里按 cwd 持有一份共享的 manager，会话只借用：omp 对借来的 manager 不做发现、不断开，
 * 单槽回调（tools / prompts / resources changed）也只由创建者设置 —— 那正是本类的位置。
 * 工具跟随用 omp 给子代理的那套（followMCPTools + createMCPProxyTools），提示命令与资源通知在这里扇出。
 *
 * 复用的判据是指纹：omp 自己的配置解析结果 + 影响发现的设置。指纹变了就换一份新的，
 * 旧的留给还在用它的会话，最后一个会话关掉时释放。
 */
export class McpWorkspaces {
  readonly #current = new Map<string, Workspace>()
  readonly #live = new Set<Workspace>()
  readonly #teardowns = new Set<Promise<void>>()
  readonly #unlisten: (() => void)[]
  readonly #graceMs: number
  #statusScheduled = false
  #closed = false

  constructor(private readonly o: McpWorkspacesOptions) {
    this.#graceMs = o.idleGraceMs ?? MCP_IDLE_GRACE_MS
    /* omp 的创建者会话监听这两格（sdk 里 `!options.mcpManager` 那一段）；借用者不会，所以由持有者来听 */
    this.#unlisten = [
      listenSetting(o.root, 'mcp.notifications', (enabled) => {
        for (const ws of this.#live) ws.manager.setNotificationsEnabled(enabled === true)
      }),
      listenSetting(o.root, 'mcp.enableProjectConfig', (enabled) => {
        for (const ws of this.#live) {
          void ws.manager
            .reconcileProjectConfig(enabled !== false)
            .catch((error: unknown) => this.o.logger.warn('mcp project config reconcile failed', errorOf(error)))
        }
      }),
    ]
  }

  /** 借一份 cwd 的 manager。指纹没变就复用（宽限期内的空闲工作区也算），变了就开一份新的 */
  async lease(cwd: string): Promise<McpLease> {
    const fingerprint = await this.#fingerprint(cwd)
    if (this.#closed) throw new Error('MCP 工作区已关闭')
    let ws = this.#current.get(cwd)
    if (ws !== undefined && ws.fingerprint !== fingerprint) {
      this.#retire(ws)
      ws = undefined
    }
    if (ws === undefined) {
      ws = this.#open(cwd, fingerprint)
      this.#current.set(cwd, ws)
    }
    const workspace = ws
    workspace.refs++
    if (workspace.idleTimer !== null) clearTimeout(workspace.idleTimer)
    workspace.idleTimer = null
    /* 先订阅再建代理（omp followMCPTools 的约定）：会话建立期间的变化会在 bind 时补放 */
    const follower = this.o.runtime.followMCPTools(workspace.manager)
    let attached: AgentSession | null = null
    let released = false
    const release = (): void => {
      if (released) return
      released = true
      if (attached === null) follower.dispose()
      else workspace.sessions.delete(attached)
      this.#unref(workspace)
    }
    return {
      manager: workspace.manager,
      release,
      attach: async (session) => {
        if (released || attached !== null) return
        attached = session
        workspace.sessions.add(session)
        follower.bind(session)
        session.addDisposer(release)
        const prompts = promptCommandsOf(workspace.manager)
        if (prompts.length > 0) session.setMCPPromptCommands(prompts)
        if (workspace.discovery === null) workspace.discovery = this.#discover(workspace, session)
        if (!workspace.settled) {
          /* 与 omp 的延迟发现同一个口径：首轮最多等 MCP_DISCOVERY_TURN_WAIT_MS，等到了就带着全部工具开始 */
          session.setPendingMCPDiscovery(
            workspace.discovery.then(async () => {
              if (!session.isDisposed)
                await session.refreshMCPTools(this.o.runtime.createMCPProxyTools(workspace.manager))
            }),
          )
          return
        }
        /* 复用已经连好的工作区：交出会话之前就把工具挂上，首轮什么都不用等 */
        const tools = this.o.runtime.createMCPProxyTools(workspace.manager)
        if (tools.length === 0) return
        await session
          .refreshMCPTools(tools)
          .catch((error: unknown) => this.o.logger.warn('mcp tool refresh failed', errorOf(error)))
      },
    }
  }

  /** MCP 配置写过了：空闲的当场释放，在用的不再借出（会话关掉就释放） */
  retireAll(): void {
    for (const ws of [...this.#live]) this.#retire(ws)
  }

  /** 状态来源：各工作区的共享 manager（当前的在前，宽限期内与退役中的也算） */
  *managers(): Iterable<MCPManager> {
    const current = new Set(this.#current.values())
    for (const ws of current) yield ws.manager
    for (const ws of this.#live) if (!current.has(ws)) yield ws.manager
  }

  /** 引擎关闭：全部释放，等子进程真正退出 */
  async dispose(): Promise<void> {
    this.#closed = true
    for (const stop of this.#unlisten) stop()
    for (const ws of [...this.#live]) this.#release(ws)
    await Promise.allSettled([...this.#teardowns])
  }

  /**
   * 指纹：omp 自己解析出的服务器配置（用户级、项目级、各工具的配置、停用名单都已算进去）+ 影响发现的设置。
   * 解析一次约 1ms（实测；omp 的配置文件读取有进程级缓存），比起杀掉重启一组进程可以忽略。解析失败也是一种状态，照样参与比较。
   */
  async #fingerprint(cwd: string): Promise<string> {
    const enableProjectConfig = readSetting(this.o.root, 'mcp.enableProjectConfig') !== false
    const extensionRoots = this.#extensionRoots()
    let configs: unknown
    try {
      configs = (
        await this.o.runtime.loadAllMCPConfigs(cwd, {
          enableProjectConfig,
          filterExa: true,
          filterBrowser: false,
          extensionRoots,
        })
      ).configs
    } catch (error) {
      configs = `error:${error instanceof Error ? error.message : String(error)}`
    }
    const text = JSON.stringify({
      configs,
      enableProjectConfig,
      startupTimeoutMs: readSetting(this.o.root, 'mcp.startupTimeoutMs'),
      browserEnabled: readSetting(this.o.root, 'browser.enabled'),
      extensionRoots,
    })
    /* 配置里可能带着环境变量与令牌：只留哈希 */
    return Bun.hash(text).toString(36)
  }

  #extensionRoots() {
    return {
      explicit: [] as string[],
      mode: 'merge' as const,
      configured: (readSetting(this.o.root, 'extensions') as string[] | undefined) ?? [],
      configuredLevel: (this.o.root as unknown as Settings).extensionsSourceLevel(),
    }
  }

  #open(cwd: string, fingerprint: string): Workspace {
    const { MCPManager, MCPToolCache } = this.o.runtime
    const storage = (this.o.root as unknown as Settings).getStorage()
    const manager = new MCPManager(cwd, storage ? new MCPToolCache(storage) : null)
    manager.setAuthStorage(this.o.authStorage as never)
    if (readSetting(this.o.root, 'mcp.notifications') === true) manager.setNotificationsEnabled(true)
    const ws: Workspace = {
      cwd,
      fingerprint,
      manager,
      sessions: new Set(),
      refs: 0,
      discovery: null,
      settled: false,
      idleSince: 0,
      idleTimer: null,
      retired: false,
      disposed: false,
      debounce: new Map(),
      unsubscribe: manager.addConnectionStatusListener(() => this.#notifyStatus()),
    }
    /* 单槽回调只由持有者设置（工具变化由各会话自己的 follower 跟，不占这一槽） */
    manager.setOnPromptsChanged(() => {
      const commands = promptCommandsOf(manager)
      for (const session of ws.sessions) if (!session.isDisposed) session.setMCPPromptCommands(commands)
    })
    manager.setOnResourcesChanged((serverName, uri) => this.#resourceChanged(ws, serverName, uri))
    this.#live.add(ws)
    return ws
  }

  /** 工作区的首次发现：由第一个 attach 的会话触发（浏览器过滤要看会话里 eval 在不在，与 omp 延迟发现同一时机） */
  async #discover(ws: Workspace, session: AgentSession): Promise<void> {
    try {
      const result = await ws.manager.discoverAndConnect({
        startupTimeoutMs: readSetting(this.o.root, 'mcp.startupTimeoutMs') as number,
        enableProjectConfig: readSetting(this.o.root, 'mcp.enableProjectConfig') !== false,
        // Exa 一律过滤：omp 有原生集成
        filterExa: true,
        filterBrowser: this.o.runtime.shouldFilterBrowserMCPForPrelude({
          restrictToolNames: false,
          browserEnabled: readSetting(this.o.root, 'browser.enabled') === true,
          evalRegistered: session.getToolByName('eval') !== undefined,
          evalActive: session.getActiveToolNames().includes('eval'),
        }),
        extensionRoots: this.#extensionRoots(),
      })
      if (ws.disposed) return
      /* omp 的 applyMCPEnvironment：被过滤掉的 Exa 服务器把钥匙交给原生集成 */
      const exaKey = result.exaApiKeys[0]
      if (exaKey !== undefined && !Bun.env.EXA_API_KEY) Bun.env.EXA_API_KEY = exaKey
      for (const [server, error] of result.errors) this.o.logger.warn('mcp server failed', { server, error })
      await ws.manager.waitForStartup(this.o.runtime.turnWaitMs)
    } catch (error) {
      this.o.logger.warn('mcp discovery failed', errorOf(error))
    } finally {
      ws.settled = true
      this.#notifyStatus()
    }
  }

  #resourceChanged(ws: Workspace, serverName: string, uri: string): void {
    if (readSetting(this.o.root, 'mcp.notifications') !== true) return
    const key = `${serverName}:${uri}`
    const existing = ws.debounce.get(key)
    if (existing !== undefined) clearTimeout(existing)
    const debounceMs = readSetting(this.o.root, 'mcp.notificationDebounceMs') as number
    ws.debounce.set(
      key,
      setTimeout(() => {
        ws.debounce.delete(key)
        // 防抖期间人可能把通知关了
        if (readSetting(this.o.root, 'mcp.notifications') !== true) return
        for (const session of ws.sessions) {
          if (!session.isDisposed) session.yieldQueue.enqueue('mcp-notification', { serverName, uri })
        }
      }, debounceMs),
    )
  }

  #retire(ws: Workspace): void {
    if (this.#current.get(ws.cwd) === ws) this.#current.delete(ws.cwd)
    ws.retired = true
    if (ws.refs === 0) this.#release(ws)
  }

  #unref(ws: Workspace): void {
    ws.refs--
    if (ws.refs > 0 || ws.disposed) return
    if (ws.retired || this.#closed) {
      this.#release(ws)
      return
    }
    ws.idleSince = performance.now()
    ws.idleTimer = setTimeout(() => this.#release(ws), this.#graceMs)
    // 宽限计时不拖住进程退出
    ;(ws.idleTimer as { unref?: () => void }).unref?.()
    const idle = [...this.#live].filter((w) => w.refs === 0).sort((a, b) => b.idleSince - a.idleSince)
    for (const stale of idle.slice(MAX_IDLE_WORKSPACES)) this.#release(stale)
  }

  #release(ws: Workspace): void {
    if (ws.disposed) return
    ws.disposed = true
    if (ws.idleTimer !== null) clearTimeout(ws.idleTimer)
    for (const timer of ws.debounce.values()) clearTimeout(timer)
    ws.debounce.clear()
    ws.unsubscribe()
    this.#live.delete(ws)
    if (this.#current.get(ws.cwd) === ws) this.#current.delete(ws.cwd)
    const { MCPManager } = this.o.runtime
    if (MCPManager.instance() === ws.manager) MCPManager.setInstance(undefined)
    const teardown = (async () => {
      await ws.manager.disconnectAll()
      /* 发现还在途时断开会中止握手，但配置读完才开始的连接要等发现收尾后再断一次（omp 延迟发现同此处理） */
      if (ws.discovery !== null) {
        await ws.discovery
        await ws.manager.disconnectAll()
      }
    })().catch((error: unknown) => this.o.logger.warn('mcp disconnect failed', errorOf(error)))
    this.#teardowns.add(teardown)
    void teardown.finally(() => this.#teardowns.delete(teardown))
    this.#notifyStatus()
  }

  /** 一个 tick 内的状态变化合成一次汇总 */
  #notifyStatus(): void {
    if (this.#statusScheduled) return
    this.#statusScheduled = true
    queueMicrotask(() => {
      this.#statusScheduled = false
      this.o.onStatus()
    })
  }
}

/** omp sdk 的 buildMCPPromptCommands（未导出）：每台已连接服务器的每条 prompt 一条 `server:prompt` 斜杠命令 */
function promptCommandsOf(manager: MCPManager): LoadedCustomCommand[] {
  const commands: LoadedCustomCommand[] = []
  for (const serverName of manager.getConnectedServers()) {
    for (const prompt of manager.getServerPrompts(serverName) ?? []) {
      const name = `${serverName}:${prompt.name}`
      commands.push({
        path: `mcp:${name}`,
        resolvedPath: `mcp:${name}`,
        source: 'bundled',
        command: {
          name,
          description: prompt.description ?? `MCP prompt from ${serverName}`,
          execute: async (args: string[]) =>
            promptTextOf(await manager.executePrompt(serverName, prompt.name, promptArgsOf(args))),
        },
      })
    }
  }
  return commands
}

/** `k=v` 形式的命令参数 → prompt 参数（没有等号、或等号打头的不算） */
function promptArgsOf(args: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const arg of args) {
    const at = arg.indexOf('=')
    if (at > 0) out[arg.slice(0, at)] = arg.slice(at + 1)
  }
  return out
}

/** prompt 的结果拼成一段文本：text 原样，resource 取它的 text */
function promptTextOf(result: Awaited<ReturnType<MCPManager['executePrompt']>>): string {
  if (result === undefined) return ''
  const parts: string[] = []
  for (const message of result.messages) {
    const items = Array.isArray(message.content) ? message.content : [message.content]
    for (const item of items) {
      if (item.type === 'text') parts.push(item.text)
      else if (item.type === 'resource' && item.resource.text) parts.push(item.resource.text)
    }
  }
  return parts.join('\n\n')
}

function errorOf(error: unknown): { error: string } {
  return { error: error instanceof Error ? error.message : String(error) }
}
