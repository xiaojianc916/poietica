import { useContributions } from '@poietica/ui-kernel'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  type ComposerToolkit,
  type ComposerToolkitSource,
  composerToolkitSources,
  type ToolkitMcpServer,
} from '../../ui-api'
import type { AgentMcpServer, AgentMcpStatus, AgentSkill, AgentToolkit } from '../agent/toolkit'

/*
 * 名册属于 extensions（它持有 `skills.list` / `mcp.status`），conversation 只画面板，中间隔一层贡献点。
 * 这一层还负责**换算**：贡献源报的是新契约那套字段，面板认的是 `status / lastError / 简化的技能行` —— 组件一字不改。
 */

/** 引用终生不变：没有贡献源时 useSyncExternalStore 需要一个稳定对象。 */
const EMPTY_AGENT_TOOLKIT: AgentToolkit = Object.freeze({ skills: [], mcpServers: [] })

/* 面板四态与契约四态同词表；没连上的画「未连接」，起不来的画错误原文。 */
function mcpStatusOf(state: ToolkitMcpServer['state']): AgentMcpStatus {
  switch (state) {
    case 'connecting':
      return 'connecting'
    case 'connected':
      return 'connected'
    case 'disconnected':
      return 'disconnected'
    case 'failed':
      return 'error'
  }
}

function mcpServerOf(server: ToolkitMcpServer): AgentMcpServer {
  return {
    id: server.name,
    name: server.name,
    status: mcpStatusOf(server.state),
    toolCount: server.toolCount,
    ...(server.error === null ? {} : { lastError: server.error }),
  }
}

/**
 * 技能按 name 去重，**排在前面的来源优先**（贡献点次序即优先级）；MCP 原样相接 —— 同一台服务器由两个来源报出来是配置错误。
 */
export function mergeToolkits(parts: readonly ComposerToolkit[]): AgentToolkit {
  const skills: AgentSkill[] = []
  const named = new Set<string>()
  const mcpServers: AgentMcpServer[] = []

  for (const part of parts) {
    for (const skill of part.skills) {
      if (named.has(skill.name)) {
        continue
      }

      named.add(skill.name)
      skills.push(skill)
    }

    for (const server of part.mcpServers) {
      mcpServers.push(mcpServerOf(server))
    }
  }

  return skills.length === 0 && mcpServers.length === 0 ? EMPTY_AGENT_TOOLKIT : { skills, mcpServers }
}

/**
 * React 要求 getSnapshot 两次调用之间交回同一个值，所以这里记住上一次各来源交回的对象：**全部没变就交回上一次的合并结果**。
 * 少这一格，每次重渲都新造一张表，订阅者认作变化，面板跟着重建 —— 一条只会自己喂自己的回路。
 */
export function toolkitReaderOf(
  sources: readonly ComposerToolkitSource[],
  workspaceId: string | null,
): () => AgentToolkit {
  let lastParts: readonly ComposerToolkit[] | undefined
  let last = EMPTY_AGENT_TOOLKIT

  return () => {
    const parts = sources.map((source) => source.read(workspaceId))

    if (
      lastParts !== undefined &&
      parts.length === lastParts.length &&
      parts.every((part, at) => part === lastParts?.[at])
    ) {
      return last
    }

    lastParts = parts
    last = mergeToolkits(parts)
    return last
  }
}

/**
 * 数据按工作区寻址（技能分层按工作目录），所以调用方要给出这一格此刻的工作区。`ensure` 只落在 effect 里：渲染期发请求会在 StrictMode 的双渲染里发两次。
 */
export function useAgentToolkit(workspaceId: string | null): AgentToolkit {
  const contributed = useContributions(composerToolkitSources)
  const sources = useMemo(() => contributed.map(({ item }) => item), [contributed])

  useEffect(() => {
    for (const source of sources) {
      source.ensure(workspaceId)
    }
  }, [sources, workspaceId])

  const subscribe = useCallback(
    (listener: () => void) => {
      const stops = sources.map((source) => source.subscribe(listener))

      return () => {
        for (const stop of stops) {
          stop()
        }
      }
    },
    [sources],
  )

  const read = useMemo(() => toolkitReaderOf(sources, workspaceId), [sources, workspaceId])

  return useSyncExternalStore(subscribe, read, read)
}
