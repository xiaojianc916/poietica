export function migrateSessionProjection(m) {
  const contract = 'packages/agent/src/timeline/timeline-contract.ts'
  m.replace(contract, `export interface TimelineState {\n  readonly status: RunStatus`, `export interface GoalProjection {\n  readonly goalId: string\n  readonly objective: string\n  readonly status: 'active' | 'paused' | 'blocked' | 'complete'\n}\n\nexport interface TimelineState {\n  readonly status: RunStatus\n  readonly goal?: GoalProjection\n  readonly activeSubagents?: readonly string[]`)

  const draft = 'packages/agent/src/timeline/timeline-draft.ts'
  m.replace(draft, `  TimelineItem,\n  TimelineState,`, `  GoalProjection,\n  TimelineItem,\n  TimelineState,`)
  m.replace(draft, `  runIndex: number\n  /**`, `  runIndex: number\n  goal: GoalProjection | undefined\n  readonly activeSubagents: Set<string>\n  /**`)
  m.replace(draft, `    runIndex: state.runIndex,\n    promptLanded: false,`, `    runIndex: state.runIndex,\n    goal: state.goal,\n    activeSubagents: new Set(state.activeSubagents ?? []),\n    promptLanded: false,`)
  m.replace(draft, `    runIndex: draft.runIndex,\n    spans: draft.spans,`, `    runIndex: draft.runIndex,\n    ...(draft.goal === undefined ? {} : { goal: draft.goal }),\n    ...(draft.activeSubagents.size === 0 ? {} : { activeSubagents: [...draft.activeSubagents] }),\n    spans: draft.spans,`)

  const reducer = 'packages/agent/src/timeline/timeline-reducer.ts'
  m.replace(reducer, `    runIndex: 0,\n    spans: [],`, `    runIndex: 0,\n    spans: [],`)
  m.replace(reducer, `    runIndex: state.runIndex,\n    spans: [...earlier.spans, ...state.spans],`, `    runIndex: state.runIndex,\n    ...(state.goal === undefined ? {} : { goal: state.goal }),\n    ...(state.activeSubagents === undefined ? {} : { activeSubagents: state.activeSubagents }),\n    spans: [...earlier.spans, ...state.spans],`)

  const projection = 'packages/agent/src/timeline/kap-projection.ts'
  m.replace(
    projection,
    `    case 'error': {\n      applyError(draft, event)`,
    `    case 'goal.updated': {\n      applyGoal(draft, event)\n      return\n    }\n\n    case 'subagent.spawned':\n    case 'subagent.started':\n    case 'subagent.suspended':\n    case 'subagent.completed':\n    case 'subagent.failed': {\n      applySubagent(draft, event)\n      return\n    }\n\n    case 'error': {\n      applyError(draft, event)`,
  )
  m.replace(
    projection,
    `/* 文本增量不带消息号`,
    `function applyGoal(draft: Draft, event: KapFrame): void {\n  const snapshot = fieldOf(event.payload, 'snapshot')\n  if (snapshot === null) {\n    draft.goal = undefined\n    return\n  }\n  if (typeof snapshot !== 'object' || snapshot === null) return\n  const goalId = Reflect.get(snapshot, 'goalId')\n  const objective = Reflect.get(snapshot, 'objective')\n  const status = Reflect.get(snapshot, 'status')\n  if (\n    typeof goalId !== 'string' ||\n    typeof objective !== 'string' ||\n    (status !== 'active' && status !== 'paused' && status !== 'blocked' && status !== 'complete')\n  ) return\n  draft.goal = { goalId, objective, status }\n}\n\nfunction applySubagent(draft: Draft, event: KapFrame): void {\n  const subagentId = stringOf(event.payload, 'subagentId')\n  if (subagentId === undefined) return\n  switch (event.payload.type) {\n    case 'subagent.spawned':\n    case 'subagent.started':\n      draft.activeSubagents.add(subagentId)\n      return\n    case 'subagent.suspended':\n    case 'subagent.completed':\n    case 'subagent.failed':\n      draft.activeSubagents.delete(subagentId)\n      return\n  }\n}\n\n/* 文本增量不带消息号`,
  )

  const queries = 'packages/agent/src/timeline/timeline-queries.ts'
  m.section(
    queries,
    `export function activeGoal(state: TimelineState): string | undefined {`,
    `/**\n * 此刻还在跑的子代理数`,
    `export function activeGoal(state: TimelineState): string | undefined {\n  return state.goal?.status === 'complete' ? undefined : state.goal?.objective\n}\n\n/**\n * 此刻还在跑的子代理数`,
    `return state.goal?.status`,
  )
  m.section(
    queries,
    `export function runningDelegations(state: TimelineState): number {`,
    `export function selectIsBusy`,
    `export function runningDelegations(state: TimelineState): number {\n  return state.activeSubagents?.length ?? 0\n}\n\nexport function selectIsBusy`,
    `state.activeSubagents?.length`,
  )

  m.write('packages/agent/src/timeline/session-projection.test.ts', `import { describe, expect, it } from 'vitest'\nimport type { RunEvent } from '@poietica/agent-contract'\nimport { activeGoal, replayRunEvents, runningDelegations } from '.'\n\nfunction event(seq: number, payload: Record<string, unknown>): RunEvent {\n  return { kind: 'kap_event', seq, at: seq, payload } as RunEvent\n}\n\ndescribe('official session projections', () => {\n  it('projects goal snapshots without inventing tool calls', () => {\n    const state = replayRunEvents([event(1, { type: 'goal.updated', snapshot: { goalId: 'g', objective: 'Ship', status: 'active' } })])\n    expect(activeGoal(state)).toBe('Ship')\n    expect(state.items).toHaveLength(0)\n  })\n  it('counts active subagents from lifecycle events', () => {\n    const state = replayRunEvents([\n      event(1, { type: 'subagent.spawned', subagentId: 'a' }),\n      event(2, { type: 'subagent.spawned', subagentId: 'b' }),\n      event(3, { type: 'subagent.completed', subagentId: 'a' }),\n    ])\n    expect(runningDelegations(state)).toBe(1)\n  })\n})\n`)
}
