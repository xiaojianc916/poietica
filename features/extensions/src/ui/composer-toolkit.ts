import type {
  ComposerToolkit,
  ComposerToolkitSource,
  ToolkitMcpServer,
  ToolkitSkill,
} from '@poietica/feature-conversation/ui-api'
import type { Logger } from '@poietica/foundation'
import type { McpServerInfo, McpStatus, SkillInfo } from '../contract'
import type { ExtensionsApi } from './api'

/* 加号面板那张名册的数据来源（conversation.composerToolkitSources 的提供方）。名册属于 extensions，conversation 只画面板。
 * 三条读法判据：**技能按工作区缓存**（omp 的 discoverSkills(cwd) 按工作目录分层）；**MCP 只有全局一份**，且**名单取配置、状态取
 * 活会话** —— mcp.status 只汇总活会话，没跑过会话时恒为空，只读状态会让面板在第一条对话之前什么都没有（真实故障）；**只画可用的
 * 技能**。失败只记 warn、保留旧值：名册是输入框上的装饰，弹错误横幅反而拦住了人打字。 */

/** 内建技能不摆进加号。 */
function visibleSkill(skill: SkillInfo): boolean {
  return skill.enabled && skill.source !== 'builtin'
}

function skillOf(skill: SkillInfo): ToolkitSkill {
  return { name: skill.name, description: skill.description, source: skill.source === 'project' ? 'project' : 'user' }
}

/** 名单说了有哪些服务器，状态说了哪几台此刻真的连着（mcp.status 只汇总活会话，没开会话时它啥也不报）。两张表按名字对齐；
 * 状态表里没有的就是「还没连上」而不是「不存在」，面板照画，画成「未连接」。 */
function stateOf(server: McpServerInfo, status: McpStatus | undefined): ToolkitMcpServer['state'] {
  if (!server.enabled) {
    return 'disconnected'
  }

  switch (status?.state) {
    case 'connected':
      return 'connected'
    case 'connecting':
      return 'connecting'
    case 'failed':
      return 'failed'
    default:
      return 'disconnected'
  }
}

function serverOf(server: McpServerInfo, statuses: ReadonlyMap<string, McpStatus>): ToolkitMcpServer {
  const status = statuses.get(server.name)

  return {
    name: server.name,
    state: stateOf(server, status),
    toolCount: status?.toolCount ?? 0,
    error: status?.error ?? null,
  }
}

const NO_TOOLKIT: ComposerToolkit = Object.freeze({ skills: [], mcpServers: [] })

function rosterOf(
  servers: readonly McpServerInfo[],
  statuses: ReadonlyMap<string, McpStatus>,
): readonly ToolkitMcpServer[] {
  return servers.map((server) => serverOf(server, statuses))
}

/** 缓存按工作区（键是 `workspaceId`，`''` 代表入口那一格），MCP 那一格不分工作区；技能或 MCP 变了才生成新对象，`read` 的交回值
 * 因此引用稳定（useSyncExternalStore 的 getSnapshot 要求）。 */
export function createComposerToolkitSource({
  api,
  logger,
}: {
  readonly api: Pick<ExtensionsApi, 'skills' | 'mcp'>
  readonly logger: Logger
}): ComposerToolkitHolder {
  const skillRows = new Map<string, readonly ToolkitSkill[]>()
  const merged = new Map<string, ComposerToolkit>()
  const skillLoads = new Map<string, number>()
  const listeners = new Set<() => void>()
  const claimed = new Map<string, string | null>()
  let mcpConfigured: readonly McpServerInfo[] = []
  let mcpStatuses: ReadonlyMap<string, McpStatus> = new Map()
  let mcpServers: readonly ToolkitMcpServer[] | undefined
  let mcpLoad: number | undefined
  let nextToken = 0
  let stopped = false

  const notify = (): void => {
    for (const listener of [...listeners]) {
      listener()
    }
  }

  const commit = (key: string): void => {
    const skills = skillRows.get(key)

    if (skills === undefined) {
      return
    }

    const before = merged.get(key)
    const nextSkills = skills
    const nextServers = mcpServers ?? []

    if (before !== undefined && before.skills === nextSkills && before.mcpServers === nextServers) {
      return
    }

    merged.set(
      key,
      Object.freeze({
        skills: nextSkills,
        mcpServers: nextServers,
      }),
    )
    notify()
  }

  const loadSkills = (key: string, workspaceId: string | null): void => {
    if (skillLoads.has(key)) {
      return
    }

    const token = ++nextToken

    skillLoads.set(key, token)
    void api.skills
      .list(workspaceId)
      .then(
        (rows) => {
          if (stopped || skillLoads.get(key) !== token) {
            return
          }

          skillRows.set(key, (rows ?? []).filter(visibleSkill).map(skillOf))
          commit(key)
        },
        (cause: unknown) => {
          if (!stopped && skillLoads.get(key) === token) {
            logger.warn('composer skill roster failed', { error: String(cause), workspaceId })
          }
        },
      )
      .finally(() => {
        if (skillLoads.get(key) === token) {
          skillLoads.delete(key)
        }
      })
  }

  /* MCP 全局一份：第一次有人要它（或 Core 重启后）读一次配置与状态，此后状态只吃 statusChanged 的推送。 */
  const loadMcp = (): void => {
    if (mcpLoad !== undefined) {
      return
    }

    const token = ++nextToken

    mcpLoad = token
    void Promise.all([api.mcp.list(), api.mcp.status()])
      .then(
        ([servers, statuses]) => {
          if (stopped || mcpLoad !== token) {
            return
          }

          /* `?? []`：首帧那份载荷可能只是个还没长出字段的空对象，名册读不到就是不画那两组，不是把整棵输入框拖崩。名单与状态一起落地：
           * 分两次提交会让面板先画一排「未连接」再跳成「已连接」。 */
          mcpConfigured = servers ?? []
          mcpStatuses = new Map((statuses ?? []).map((row) => [row.name, row]))
          mcpServers = rosterOf(mcpConfigured, mcpStatuses)
          for (const key of merged.keys()) {
            commit(key)
          }
        },
        (cause: unknown) => {
          if (!stopped && mcpLoad === token) {
            logger.warn('composer mcp roster failed', { error: String(cause) })
          }
        },
      )
      .finally(() => {
        if (mcpLoad === token) {
          mcpLoad = undefined
        }
      })
  }

  return {
    id: 'extensions.composerToolkit',
    ensure(workspaceId) {
      if (stopped) {
        return
      }

      const key = workspaceId ?? ''

      claimed.set(key, workspaceId)

      if (!skillRows.has(key)) {
        loadSkills(key, workspaceId)
      }

      if (mcpServers === undefined) {
        loadMcp()
      }
    },
    read(workspaceId) {
      return merged.get(workspaceId ?? '') ?? NO_TOOLKIT
    },
    subscribe(listener) {
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },

    skillsChanged(): void {
      if (stopped) {
        return
      }

      /* 不清 `merged`：旧行留到新数据落地，面板不闪一下空白。在飞的那几趟一并作废。 */
      skillRows.clear()
      skillLoads.clear()

      for (const [key, workspaceId] of claimed) {
        loadSkills(key, workspaceId)
      }
    },

    reset(): void {
      if (stopped) {
        return
      }

      skillRows.clear()
      merged.clear()
      skillLoads.clear()
      mcpConfigured = []
      mcpStatuses = new Map()
      mcpServers = undefined
      mcpLoad = undefined

      for (const [key, workspaceId] of claimed) {
        loadSkills(key, workspaceId)
      }

      if (claimed.size > 0) {
        loadMcp()
      }
    },

    mcpChanged(rows: readonly McpStatus[]): void {
      if (stopped) {
        return
      }

      mcpStatuses = new Map((rows ?? []).map((row) => [row.name, row]))
      mcpServers = rosterOf(mcpConfigured, mcpStatuses)

      for (const key of merged.keys()) {
        commit(key)
      }
    },

    stop(): void {
      stopped = true
      listeners.clear()
    },
  }
}

export type ComposerToolkitHolder = ComposerToolkitSource & {
  skillsChanged(): void
  reset(): void
  mcpChanged(rows: readonly McpStatus[]): void
  stop(): void
}
