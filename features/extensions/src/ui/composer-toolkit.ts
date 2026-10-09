import type {
  ComposerToolkit,
  ComposerToolkitSource,
  ToolkitMcpServer,
  ToolkitSkill,
} from '@poietica/feature-conversation/ui-api'
import type { Logger } from '@poietica/foundation'
import type { McpServerInfo, McpStatus, SkillInfo } from '../contract'
import type { ExtensionsApi } from './api'

/*
 * 加号面板那张名册的数据来源（`conversation.composerToolkitSources` 的提供方）。
 *
 * 名册属于 extensions：`skills.list` 与 `mcp.status`（外加 `skills.changed` /
 * `mcp.statusChanged` 两条通知）都在这里，conversation 只画面板。07 页 §5E 迁移时
 * 没给这两组留数据落点，于是加号面板恒为空 —— 这一份就是那个落点（见 refactor-log）。
 *
 * 三条读法上的判据：
 *   - **技能按工作区缓存**：omp 的 discoverSkills(cwd) 按工作目录分层，所以换项目换名册；
 *   - **MCP 只有全局一份**：配置文件是用户级的（<ompAgentDir>/mcp.json），各工作区共用
 *     同一次读，不必每个工作区各打一趟。**名单取配置、状态取活会话**：`mcp.list` 是
 *     「装了哪些」，`mcp.status` 是「此刻连上了哪些」—— 后者只汇总活会话，没跑过会话
 *     时恒为空。只读状态会让面板在第一条对话之前什么都没有（那正是这一处的真实故障）；
 *     只读配置又丢了连接状态。两张表按名字合起来才是面板要的那一份。
 *   - **只画可用的技能**：`enabled` 为假的不出现，`builtin` 也不出现 —— 与 legacy 面板
 *     同一条过滤（内建技能不摆进加号）。
 *
 * 失败只记 warn、保留旧值（没有旧值就是空）：名册是输入框上的装饰，弹一个错误横幅反而
 * 拦住了人打字；下一次 ensure（换工作区、Core 重启）自然重试。
 */

/** legacy 面板只列这两档：内建技能不摆进加号。 */
function visibleSkill(skill: SkillInfo): boolean {
  return skill.enabled && skill.source !== 'builtin'
}

function skillOf(skill: SkillInfo): ToolkitSkill {
  return { name: skill.name, description: skill.description, source: skill.source === 'project' ? 'project' : 'user' }
}

/**
 * 连接态与配置的启用态合成面板那一格。
 *
 * 名单说了有哪些服务器，状态说了哪几台此刻真的连着（`mcp.status` 只汇总活会话，
 * 没开会话时它啥也不报）。两张表按名字对齐；状态表里没有的就是「还没连上」，
 * 而不是「不存在」—— 面板照画，画成「未连接」。
 */
function stateOf(server: McpServerInfo, status: McpStatus | undefined): ToolkitMcpServer['state'] {
  /* 停用是配置那一格的事实：连接态无论报什么都先说「用不上它」。 */
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
    /* 没报（还没开会话）或明确停用：面板这一档都是「未连接」。 */
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

/** `read` 的空答案。引用固定：没有缓存的那些工作区共用它，getSnapshot 才比得动。 */
const NO_TOOLKIT: ComposerToolkit = Object.freeze({ skills: [], mcpServers: [] })

/** 名单 × 状态 → 面板的行。声明次序跟着配置走（与设置页同一个次序）。 */
function rosterOf(
  servers: readonly McpServerInfo[],
  statuses: ReadonlyMap<string, McpStatus>,
): readonly ToolkitMcpServer[] {
  return servers.map((server) => serverOf(server, statuses))
}

/**
 * 一台来源。
 *
 * 缓存按工作区（键是 `workspaceId`，`''` 代表入口那一格 —— 它与任何一个具体工作区
 * 不是同一份），MCP 那一格不分工作区：技能或 MCP 变了才生成新对象，`read` 的交回值
 * 因此引用稳定（useSyncExternalStore 的 getSnapshot 要求）。
 */
export function createComposerToolkitSource({
  api,
  logger,
}: {
  readonly api: Pick<ExtensionsApi, 'skills' | 'mcp'>
  readonly logger: Logger
}): ComposerToolkitHolder {
  const skillRows = new Map<string, readonly ToolkitSkill[]>()
  const merged = new Map<string, ComposerToolkit>()
  /* 在飞的那一趟（值是不重复的令牌）。作废靠换掉令牌，不靠取消请求 —— 请求已经发出去了。 */
  const skillLoads = new Map<string, number>()
  const listeners = new Set<() => void>()
  /* 认领过的那些工作区：Core 重启、技能变化之后按它重读。 */
  const claimed = new Map<string, string | null>()
  /* MCP 的配置那一份（`mcp.list`）：名单的次序与启用态跟着它走。 */
  let mcpConfigured: readonly McpServerInfo[] = []
  /* MCP 的状态那一份（`mcp.status` / `mcp.statusChanged`）：按名字对齐到名单上。 */
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

  /** 按当前两格缓存合成这个工作区的那一份；内容跟上一份一样就不落、也不叫。 */
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
          /* 令牌换了就是这一趟已作废（期间来过 skills.changed / reset / stop）。 */
          if (stopped || skillLoads.get(key) !== token) {
            return
          }

          /* 与下面 loadMcp 同一条处置：还没长出字段的空载荷当「没有」处理。 */
          skillRows.set(key, (rows ?? []).filter(visibleSkill).map(skillOf))
          commit(key)
        },
        (cause: unknown) => {
          /* 读失败保留旧值（没有旧值就是空）；下一次 ensure 重试。 */
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

  /*
   * MCP：全局一份。第一次有人要它（或 Core 重启后）读一次配置与状态；此后配置不动，
   * 状态只吃 statusChanged 的推送。
   */
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

          /*
           * `?? []`：首帧那份载荷可能只是个还没长出字段的空对象（宿主 stub、测试桩、
           * Core 刚起来），与 control-shapes 的 `sessionConfigControlsOf` 同一条处置 ——
           * 名册读不到就是不画那两组，不是把整棵输入框拖崩。
           *
           * 名单与状态一起落地：分两次提交会让面板先画一排「未连接」再跳成「已连接」。
           */
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
    /* ── 下面两条不进贡献点接口：装配层在 lifecycle 里调它们 ─────────────── */

    /** `skills.changed`：清空技能缓存，按认领过的工作区重读。 */
    skillsChanged(): void {
      if (stopped) {
        return
      }

      /*
       * 不清 `merged`：名字册的旧行留到新数据落地，面板不闪一下空白。在飞的那几趟
       * 一并作废（清掉令牌 = 它们的回话落不进来），再按认领过的工作区重新要。
       */
      skillRows.clear()
      skillLoads.clear()

      for (const [key, workspaceId] of claimed) {
        loadSkills(key, workspaceId)
      }
    },

    /** Core 进入 ready（含崩溃重启）：技能与 MCP 都清空重来。 */
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

    /** `mcp.statusChanged`：整份替换，不重读。 */
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

/** 装配层手里那一台：贡献点接口 + 三条生命周期入口。 */
export type ComposerToolkitHolder = ComposerToolkitSource & {
  skillsChanged(): void
  reset(): void
  mcpChanged(rows: readonly McpStatus[]): void
  stop(): void
}
