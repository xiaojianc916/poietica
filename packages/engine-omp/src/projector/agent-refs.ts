import type { AgentRef } from '@poietica/transcript'

/*
 * 派发工具帧 → 它派出去的子代理（`agentRefs`）。从工具结果的 details 读、不从总线读：
 * omp 的 task 工具在流式中间结果与最终结果里都带 `details.progress[] / details.results[]`，
 * 每项的 `id` 就是子代理的号；总线上的帧只在这一次运行里有，重开之后只剩会话文件里的工具结果 ——
 * 从 details 读，实时与历史两条路给出同一份 agentRefs，重开前后「点开子代理」是同一个入口。
 */

/** 只有 omp 的 task 工具会派子代理（tools/task 的 `readonly name = "task"`） */
export const TASK_TOOL = 'task'

/** 通道号必须与时间线的 agent_id 同一套字符集（transcript 的 AGENT_ID_PATTERN）；'main' 留给主对话 */
const AGENT_ID = /^[A-Za-z0-9._-]{1,128}$/

export function isSubagentChannelId(agentId: string): boolean {
  return AGENT_ID.test(agentId) && agentId !== 'main' && agentId !== '.' && agentId !== '..'
}

function idsIn(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const ids: string[] = []
  for (const entry of value) {
    const id = typeof entry === 'object' && entry !== null ? (entry as { readonly id?: unknown }).id : undefined
    if (typeof id === 'string' && isSubagentChannelId(id)) ids.push(id)
  }
  return ids
}

/** 工具帧的 output（`{ content, details }`）→ 它派出去的子代理；不是派发工具或还没有子代理时交 undefined（帧上不写这一格） */
export function agentRefsOf(toolName: string, output: unknown): readonly AgentRef[] | undefined {
  if (toolName !== TASK_TOOL || typeof output !== 'object' || output === null) return undefined
  const details = (output as { readonly details?: unknown }).details
  if (typeof details !== 'object' || details === null) return undefined
  const record = details as { readonly progress?: unknown; readonly results?: unknown }
  /* 去重保序：progress 先到（跑着就有），results 在收口时补齐；同一个子代理两边都列 */
  const ids = [...new Set([...idsIn(record.progress), ...idsIn(record.results)])]
  return ids.length === 0 ? undefined : ids.map((agentId) => ({ agentId, role: 'child' as const }))
}
