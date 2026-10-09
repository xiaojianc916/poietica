import path from 'node:path'
import { loadAllMCPConfigs } from '@oh-my-pi/pi-coding-agent/mcp/config'
import {
  addMCPServer,
  readMCPConfigFile,
  removeMCPServer,
  setServerDisabled,
  updateMCPServer,
} from '@oh-my-pi/pi-coding-agent/mcp/config-writer'
import type { McpPort, McpServerInfo, McpStatus } from '@poietica/engine'
import { Emitter, type Logger } from '@poietica/foundation'
import type { z } from 'zod'
import { toEngineError } from '../errors'
import type { OmpMcpManager, OmpSessionLike } from '../omp-context'

/** 用户级 MCP 配置文件：<ompAgentDir>/mcp.json（omp 自己的位置，不自己拼 JSON）。 */
const MCP_CONFIG_NAME = 'mcp.json'

/** McpPort 需要的东西：omp 的 agent 目录、活着的会话（状态要汇总它们）、logger。 */
export interface McpPortDeps {
  readonly ompAgentDir: string
  readonly sessions: ReadonlySet<OmpSessionLike>
  readonly logger: Logger
}

/**
 * MCP 端口。读配置走 omp 的 loadAllMCPConfigs（只读配置，不发起连接）；写的是用户级
 * <ompAgentDir>/mcp.json，一律经 omp 的 mcp/config-writer，不自己拼 JSON（校验、原子写、
 * disabledServers 的清理规则都是它的事）。状态从活会话的 mcpManager 汇总。
 */
export class OmpMcpPort implements McpPort {
  readonly #change = new Emitter<z.infer<typeof McpStatus>[]>()
  readonly onDidChangeStatus = this.#change.event

  constructor(private readonly d: McpPortDeps) {}

  /**
   * 配置里有哪些服务器（用户级 + 项目级 + 各工具自己的配置，omp 认得多少就报多少）。
   *
   * loadAllMCPConfigs 会把 disabledServers 里的服务器**整份滤掉**（实测：加进停用名单后
   * configs 里就没有它了），所以停用的那几台要另从用户级文件里补回来 —— 否则界面上的
   * 「已停用」一栏永远是空的，人也就没法再把它打开。
   */
  async list(): Promise<z.infer<typeof McpServerInfo>[]> {
    try {
      const loaded = await loadAllMCPConfigs(process.cwd())
      const rows = new Map<string, z.infer<typeof McpServerInfo>>()
      for (const [name, config] of Object.entries(loaded.configs)) {
        rows.set(name, {
          name,
          transport: transportOf(config),
          enabled: config.enabled !== false,
          config: { ...(config as unknown as Record<string, unknown>) },
        })
      }
      const file = await readMCPConfigFile(this.#configFile())
      const disabled = new Set(file.disabledServers ?? [])
      for (const [name, config] of Object.entries(file.mcpServers ?? {})) {
        if (!disabled.has(name) || rows.has(name)) continue
        rows.set(name, {
          name,
          transport: transportOf(config),
          enabled: false,
          config: { ...(config as unknown as Record<string, unknown>) },
        })
      }
      return [...rows.values()].sort((left, right) => left.name.localeCompare(right.name))
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 写一台服务器：不认识就 add，认识就 update（omp 的 config-writer 负责校验与原子写）。 */
  async upsert(server: z.infer<typeof McpServerInfo>): Promise<void> {
    try {
      const file = this.#configFile()
      const config = mcpConfigOf(server)
      const known = (await loadAllMCPConfigs(process.cwd())).configs
      if (server.name in known) await updateMCPServer(file, server.name, config)
      else await addMCPServer(file, server.name, config)
      /* 配置里带着 enabled，这里把它同时落到 disabledServers：omp 的列出判据看的是那一格。 */
      await setServerDisabled(file, server.name, !server.enabled)
      this.#fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 删一台服务器：omp 的 removeMCPServer 要求它确实存在，不存在时如实转成 AppError。 */
  async remove(name: string): Promise<void> {
    try {
      await removeMCPServer(this.#configFile(), name)
      this.#fire()
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 各活跃会话的 mcpManager 汇总，按服务器名合并；没有会话就没有状态。 */
  async status(): Promise<z.infer<typeof McpStatus>[]> {
    try {
      const merged = new Map<string, z.infer<typeof McpStatus>>()
      for (const session of this.d.sessions) {
        for (const row of statusOf(session.mcpManager)) {
          if (!merged.has(row.name)) merged.set(row.name, row)
        }
      }
      return [...merged.values()]
    } catch (error) {
      throw toEngineError(error)
    }
  }

  /** 会话状态变化时由 OmpEngine 调一次：按名汇总后 fire。 */
  refreshStatus(): void {
    void this.status().then(
      (rows) => this.#change.fire(rows),
      (error: unknown) => this.d.logger.warn('mcp status refresh failed', { error: String(error) }),
    )
  }

  /** 端口释放（AgentEngine.dispose 时一并释放监听器）。 */
  dispose(): void {
    this.#change.dispose()
  }

  async #fire(): Promise<void> {
    this.#change.fire(await this.status())
  }

  #configFile(): string {
    return path.join(this.d.ompAgentDir, MCP_CONFIG_NAME)
  }
}

/** 契约的 transport 三档（omp 的 stdio / http / sse 与它逐字对应）。 */
function transportOf(config: { type?: string }): 'stdio' | 'http' | 'sse' {
  if (config.type === 'http') return 'http'
  if (config.type === 'sse') return 'sse'
  return 'stdio'
}

/** 契约的 server → omp 的 MCPServerConfig：transport 决定必填字段，其余原样透传。 */
function mcpConfigOf(server: z.infer<typeof McpServerInfo>): never {
  const raw = server.config
  if (server.transport === 'stdio') {
    const command = raw.command
    if (typeof command !== 'string' || command === '') {
      throw new Error('stdio 的 MCP 服务器必须给 command')
    }
    return { type: 'stdio', command, ...raw } as never
  }
  const url = raw.url
  if (typeof url !== 'string' || url === '') throw new Error('远程 MCP 服务器必须给 url')
  return { type: server.transport, url, ...raw } as never
}

/**
 * 一台会话里某个 MCP 管理器的状态。omp 18.5.0 的 MCPManager 没有批量状态接口
 * （只有 getAllServerNames / getConnectionStatus / getConnection），所以逐个名字问；
 * getServerStatus 若存在则优先用它（别的实现可能有）。
 */
function statusOf(manager: OmpMcpManager | undefined): readonly z.infer<typeof McpStatus>[] {
  if (manager === undefined) return []
  if (manager.getServerStatus !== undefined) {
    return manager.getServerStatus().map((row) => ({
      name: row.name,
      state: stateOf(row.state),
      toolCount: row.toolCount ?? 0,
      error: row.error ?? null,
    }))
  }
  const names = manager.getAllServerNames?.() ?? []
  return names.map((name) => ({
    name,
    state: stateOf(manager.getConnectionStatus?.(name)),
    toolCount: manager.getConnection?.(name)?.tools?.length ?? 0,
    error: null,
  }))
}

/**
 * omp 的三态 + 配置开关 → 契约的四态：connected / connecting 原样，
 * **disconnected → failed**（契约没有「断开」这一格，而「断开」在界面上与「连不上」是同一件事：
 * 都用不了、都要给错误提示），disabled 由 disabledServers 决定而不是这里的连接态。
 */
function stateOf(state: string | undefined): 'connecting' | 'connected' | 'failed' | 'disabled' {
  if (state === 'connected') return 'connected'
  if (state === 'connecting') return 'connecting'
  if (state === 'disabled') return 'disabled'
  return 'failed'
}
