import type { TranscriptOperation, TranscriptTask } from '@poietica/transcript'

/*
 * omp 的后台作业（AsyncJobManager：`bash` 后台命令、`eval` 后台单元）→ transcript 的 task 行（kind shell / tool，detached）。
 *
 * omp 不为作业的变化发事件（只有完成后的投递），能拿到的是 `session.getAsyncJobSnapshot()` 这张现成的表 ——
 * 与 omp 自己的状态栏、/jobs 面板读的是同一份。所以这里是**按快照对账**：调用方在有作业跑着时定时取一次、
 * 在工具收口 / 一轮结束时再取一次，交进来；投影结果真的变了才发 op（与 SubagentLedger 同一个去重口径）。
 *
 * `task` 类作业是后台子代理：它们归「智能体」那一节（SubagentLedger 从生命周期帧出行），这里不列，
 * 否则同一个子代理会在两节里各出现一次。
 */

/** 快照里的一项（omp AsyncJobSnapshotItem 的结构收窄；认不出的格当缺席） */
export interface AsyncJobRow {
  readonly id: string
  readonly type: string
  readonly status: string
  readonly label?: string
  readonly command?: string
  readonly startTime?: number
  readonly endTime?: number
}

/** task 行号加前缀：作业号与子代理号是两套命名，前缀保证两张表的行永不互相覆盖 */
const JOB_TASK_PREFIX = 'job:'

export function jobTaskId(jobId: string): string {
  return JOB_TASK_PREFIX + jobId
}

/** task 行号 → omp 的作业号；不是作业行（例如子代理行）交 null */
export function jobIdOf(taskId: string): string | null {
  return taskId.startsWith(JOB_TASK_PREFIX) && taskId.length > JOB_TASK_PREFIX.length
    ? taskId.slice(JOB_TASK_PREFIX.length)
    : null
}

function kindOf(type: string): TranscriptTask['kind'] | null {
  if (type === 'bash') return 'shell'
  if (type === 'eval') return 'tool'
  /* task = 后台子代理（见头注）；将来的新类型先不列，宁缺不错 */
  return null
}

/** omp 四档 → TaskState：cancelled 是「被停了」，落 killed（与子代理的 aborted 同一个落点） */
function stateOf(status: string): TranscriptTask['state'] | null {
  switch (status) {
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'killed'
    default:
      return null
  }
}

export function rowsOf(snapshot: unknown): readonly AsyncJobRow[] {
  if (typeof snapshot !== 'object' || snapshot === null) return []
  const { running, recent } = snapshot as { readonly running?: unknown; readonly recent?: unknown }
  const rows: AsyncJobRow[] = []
  for (const list of [running, recent]) {
    if (!Array.isArray(list)) continue
    for (const entry of list) {
      const row = rowOf(entry)
      if (row !== null) rows.push(row)
    }
  }
  return rows
}

function rowOf(entry: unknown): AsyncJobRow | null {
  if (typeof entry !== 'object' || entry === null) return null
  const raw = entry as Record<string, unknown>
  if (typeof raw.id !== 'string' || raw.id === '' || typeof raw.type !== 'string' || typeof raw.status !== 'string') {
    return null
  }
  return {
    id: raw.id,
    type: raw.type,
    status: raw.status,
    ...(typeof raw.label === 'string' && raw.label !== '' ? { label: raw.label } : {}),
    ...(typeof raw.command === 'string' && raw.command !== '' ? { command: raw.command } : {}),
    ...(typeof raw.startTime === 'number' ? { startTime: raw.startTime } : {}),
    ...(typeof raw.endTime === 'number' ? { endTime: raw.endTime } : {}),
  }
}

/**
 * 作业账：作业号 → 那一行 task。快照只保留最近几条已结作业（omp 有保留期），**从快照里消失不等于没发生过** ——
 * 已经上过屏的行留着（终态不再改）；还在跑就消失的（会话重开、作业被逐出）标 lost，不让它在面板上永远转圈。
 */
export class BackgroundJobLedger {
  private readonly tasksById = new Map<string, TranscriptTask>()

  get tasks(): readonly TranscriptTask[] {
    return [...this.tasksById.values()]
  }

  get hasRunning(): boolean {
    for (const task of this.tasksById.values()) if (task.state === 'running') return true
    return false
  }

  reconcile(snapshot: unknown): TranscriptOperation[] {
    const ops: TranscriptOperation[] = []
    const seen = new Set<string>()
    for (const row of rowsOf(snapshot)) {
      const task = this.taskOf(row, seen)
      if (task !== null) ops.push(...this.commit(task))
    }
    for (const task of this.tasksById.values()) {
      if (task.state === 'running' && !seen.has(task.taskId)) {
        ops.push(...this.commit({ ...task, state: 'lost', stateReason: 'job_vanished' }))
      }
    }
    return ops
  }

  /** 一行作业 → 任务行；认不出的、本轮已见过的、已到终态的交回 null（seen 在这里记账）。 */
  private taskOf(row: AsyncJobRow, seen: Set<string>): TranscriptTask | null {
    const kind = kindOf(row.type)
    const state = stateOf(row.status)
    if (kind === null || state === null) return null
    const taskId = jobTaskId(row.id)
    if (seen.has(taskId)) return null
    seen.add(taskId)
    const previous = this.tasksById.get(taskId)
    /* 终态不再改：omp 的 recent 表会把同一条已结作业一直报下去 */
    if (previous !== undefined && previous.state !== 'running') return null
    return {
      taskId,
      kind,
      state,
      detached: true,
      description: row.label ?? row.command ?? row.id,
      outputTail: previous?.outputTail ?? '',
      ...(row.startTime === undefined ? {} : { startedAt: iso(row.startTime) }),
      ...(row.endTime === undefined ? {} : { endedAt: iso(row.endTime) }),
    }
  }

  private commit(task: TranscriptTask): TranscriptOperation[] {
    const previous = this.tasksById.get(task.taskId)
    if (previous !== undefined && sameTask(previous, task)) return []
    this.tasksById.set(task.taskId, task)
    return [{ op: 'task.upsert', task }]
  }
}

function sameTask(left: TranscriptTask, right: TranscriptTask): boolean {
  return (
    left.state === right.state &&
    left.kind === right.kind &&
    left.description === right.description &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.stateReason === right.stateReason
  )
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}
