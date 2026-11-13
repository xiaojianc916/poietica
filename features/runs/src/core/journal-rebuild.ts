import type { CommittedAgentEvent, TranscriptItem, TranscriptPage, TranscriptTurn } from '@poietica/agent-model'

type EventBase = (at: string) => {
  schema: number
  durability: 'committed'
  at: string
  threadId: string
  agentId: string
}

/**
 * 把 omp 会话文件投影出的一页重建成可写入 Journal 的 committed 事件（ADR-005 的渐进回填）。
 * 只用于**一页装得下**的会话：调用方先确认 `hasMoreOlder` 为 false，避免把分页拼错。
 * 事件按时间线模型原样还原：轮/步头 + 每帧 item.completed + 侧表 upsert；marker/taskref 按
 * 在 items 里的位置换算成 `beforeTurn`。不重建瞬态增量和 usage 采样（会话文件里没有）。
 */
export function eventsFromPage(
  page: TranscriptPage,
  threadId: string,
  agentId: string,
  now: string,
): CommittedAgentEvent[] {
  const base: EventBase = (at) => ({ schema: 1, durability: 'committed', at, threadId, agentId })
  const events: CommittedAgentEvent[] = []
  for (const [index, item] of page.items.entries()) {
    events.push(...itemEvents(item, nextTurnOrdinal(page.items, index), base, now))
  }
  events.push(...sideTableEvents(page, base, now))
  return events
}

/** 把从新到旧的分页按轮序拼回一页；侧表取头页（最新的一份），缺省字段沿用头页。 */
export function pagesToPage(pages: readonly TranscriptPage[]): TranscriptPage | null {
  if (pages.length === 0) return null
  const head = pages[0]!
  const items = [...pages].reverse().flatMap((page) => page.items)
  return {
    ...head,
    items,
    hasMoreOlder: false,
  }
}

function itemEvents(
  item: TranscriptItem,
  beforeTurn: number | undefined,
  base: EventBase,
  now: string,
): CommittedAgentEvent[] {
  if (item.kind === 'marker') {
    return [
      {
        ...base(item.at ?? now),
        type: 'marker.raised',
        item,
        ...(beforeTurn === undefined ? {} : { beforeTurn }),
      },
    ]
  }
  if (item.kind === 'taskref') {
    return [
      {
        ...base(item.at ?? now),
        type: 'task.linked',
        item,
        ...(beforeTurn === undefined ? {} : { beforeTurn }),
      },
    ]
  }
  return turnEvents(item, base, now)
}

function turnEvents(turn: TranscriptTurn, base: EventBase, now: string): CommittedAgentEvent[] {
  const { steps, ...header } = turn
  const startAt = turn.startedAt ?? now
  const events: CommittedAgentEvent[] = [{ ...base(startAt), type: 'run.started', runId: turn.turnId, run: header }]
  for (const step of steps) {
    const { frames, ...stepHeader } = step
    const at = step.startedAt ?? startAt
    events.push({ ...base(at), type: 'step.started', turnId: turn.turnId, step: stepHeader })
    for (const frame of frames) {
      events.push({ ...base(at), type: 'item.completed', turnId: turn.turnId, stepId: step.stepId, frame })
    }
  }
  const completed = completedEvent(turn, base, startAt)
  if (completed !== undefined) events.push(completed)
  return events
}

function completedEvent(turn: TranscriptTurn, base: EventBase, startAt: string): CommittedAgentEvent | undefined {
  if (turn.state !== 'completed' && turn.state !== 'failed' && turn.state !== 'cancelled') return undefined
  return {
    ...base(turn.endedAt ?? startAt),
    type: 'run.completed',
    runId: turn.turnId,
    outcome: turn.state,
    ...(turn.endedAt === undefined ? {} : { endedAt: turn.endedAt }),
    ...(turn.usage === undefined ? {} : { usage: turn.usage }),
    ...(turn.durationMs === undefined ? {} : { durationMs: turn.durationMs }),
    ...(turn.error === undefined ? {} : { error: turn.error }),
  }
}

function sideTableEvents(page: TranscriptPage, base: EventBase, now: string): CommittedAgentEvent[] {
  const events: CommittedAgentEvent[] = []
  for (const task of page.tasks) {
    events.push({
      ...base(task.startedAt ?? now),
      type: task.state === 'running' ? 'task.started' : 'task.finished',
      task,
    })
  }
  for (const interaction of page.interactions) {
    events.push({
      ...base(now),
      type: interaction.state === 'pending' ? 'interaction.requested' : 'interaction.resolved',
      interaction,
    })
  }
  for (const attachment of page.attachments) {
    events.push({ ...base(now), type: 'attachment.added', attachment })
  }
  for (const todo of page.todos) {
    events.push({ ...base(now), type: 'todo.updated', todo })
  }
  for (const prompt of page.prompts) {
    events.push({ ...base(now), type: 'prompt.updated', prompt })
  }
  events.push({ ...base(now), type: 'agent.updated', meta: page.meta })
  return events
}

function nextTurnOrdinal(items: readonly TranscriptItem[], from: number): number | undefined {
  for (let i = from + 1; i < items.length; i += 1) {
    const item = items[i]
    if (item?.kind === 'turn') return item.ordinal
  }
  return undefined
}
