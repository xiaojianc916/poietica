import type { AgentFaceStatus } from '@poietica/conversation-kit/primitives'
import type { SubagentItem, TimelineState, ToolCallTimelineItem } from '@poietica/conversation-kit/timeline'
import type { OmpTaskToolInput } from '@poietica/omp-types'
import { delegationOf } from './delegate-channel'

/*
 * 派发行的三个读数：谁（类型名，取身份色）、做什么（那次派发的描述）、此刻什么状态（决定脸的表情）。
 * 照 ZCode 的 Agent 摘要行（renderers/agent.tsx 的 AgentNameText + primaryText）——
 * 屏幕上就是「General Purpose  这行灰字」，没有工具名，也没有状态词：运行与完成由脸和勾说。
 *
 * 纯函数：时间线的行与右坞的标签都从这一份读，两处不各算各的。入参按 omp 的 task 形状读，
 * 不在这里猜字段名（那个形状由 omp 的 tool schema 保证，见 @poietica/omp-types）。
 */

/** 类型名的印法：连字符换空格，每个词首字母大写（general-purpose → General Purpose）。 */
export function sayAgentType(name: string): string {
  return name.replace(/-/g, ' ').replace(/\b\p{L}/gu, (letter) => letter.toUpperCase())
}

function textOf(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

/** 派发入参里这一条的类型名：批次按序号对，平铺那一档只有顶层一个。 */
function typeNameIn(input: OmpTaskToolInput | undefined, index: number): string | undefined {
  return textOf(input?.tasks?.[index]?.agent) ?? textOf(input?.agent)
}

/**
 * 派发入参里这一条的描述：批次那一档只看这一项自己（描述 → 任务正文首行），
 * 平铺那一档才读顶层 —— 批量的 tasks[0] 与顶层 task 不是同一件事，混着读会把别人的话安到这一行上。
 */
function describedIn(input: OmpTaskToolInput | undefined, index: number): string | undefined {
  const mine = input?.tasks?.[index]
  const said = textOf(mine === undefined ? (input?.description ?? input?.task) : (mine.description ?? mine.task))
  if (said === undefined) return undefined
  const cut = said.indexOf('\n')
  return cut === -1 ? said : said.slice(0, cut)
}

/** 生命周期那一栏报的状态 → 脸的表情档。没报过就不给（脸停在等待那一档）。 */
export function faceStatusOf(status: SubagentItem['status'] | undefined): AgentFaceStatus | undefined {
  if (status === undefined) return undefined
  if (status === 'running') return 'running'
  if (status === 'completed') return 'done'
  return 'failed'
}

export interface DelegateRow {
  readonly agentId: string
  /** 身份色与类型名同一格：这一行是谁。 */
  readonly type: string
  /** 那次派发要它做的事；两处都问不出来时退回通道号，不留空。 */
  readonly description: string
  readonly status: AgentFaceStatus | undefined
}

/**
 * 一次派发摊成几行：一个子代理一行。描述取**引擎报的生命周期**（按 agentId 对上，权威），
 * 那一刻还没有生命周期帧（刚派出去）才退回入参里模型自己写的那句。
 */
export function delegateRowsOf(item: ToolCallTimelineItem, subagents: readonly SubagentItem[]): readonly DelegateRow[] {
  const input = item.rawInput as OmpTaskToolInput | undefined
  return item.channels.map((channel, index) => {
    const listed = subagents.find((one) => one.agentId === channel.agentId)
    return {
      agentId: channel.agentId,
      type: sayAgentType(typeNameIn(input, index) ?? channel.name),
      description: listed?.description ?? describedIn(input, index) ?? channel.name,
      status: faceStatusOf(listed?.status),
    }
  })
}
/**
 * 一个已知 agentId 的类型名：与派发行同一份读法（入参点名的 agent → 通道名 → agentId）。
 * 右坞的标签与通道面板的头都读它取身份色 —— 三处同一个 key，同一个子代理才是同一个颜色。
 * 查不到那次派发（老对话只剩生命周期帧）时退回 agentId，颜色仍然定得住。
 */
export function agentTypeOf(timeline: Pick<TimelineState, 'subagents' | 'sealed' | 'active'>, agentId: string): string {
  const call = delegationOf(timeline as TimelineState, agentId)
  if (call === undefined) return agentId
  return delegateRowsOf(call, timeline.subagents).find((row) => row.agentId === agentId)?.type ?? agentId
}
