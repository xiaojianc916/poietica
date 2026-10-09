import type { TranscriptOperation, TranscriptTask } from '@poietica/transcript'

/*
 * omp 子代理可观测面 → transcript 的 task 行（12 页 §9.3，原样迁移 legacy subagents.ts）。
 *
 * omp 把子代理的生死与进度推在根作用域总线上（createAgentSession 交回的 subagentEventBus，
 * 频道名从 '@oh-my-pi/pi-tui/overlays/session-observer-registry' 导入，不手写字符串）。
 * 纯状态机，不碰 SDK：事件形状按结构收窄（认不出的格当缺席），能被单测逐条钉住。
 */

/** 一条子代理的生命周期帧（pi-tui 的 SubagentLifecyclePayload） */
export interface SubagentLifecycleFrame {
  readonly id: string
  readonly description?: string
  readonly status?: string
  readonly detached?: boolean
}

/** 一条进度帧（SubagentProgressPayload）；只列我们真的会读的格 */
export interface SubagentProgressFrame {
  readonly task?: string
  readonly detached?: boolean
  readonly progress: {
    readonly id: string
    readonly status?: string
    readonly description?: string
    readonly lastIntent?: string
    readonly recentOutput?: readonly string[]
    readonly resolvedModel?: string
    readonly resolvedThinkingLevel?: string
  }
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function stringOf(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 生命周期帧：号是唯一的必需格，取不到就整帧作废 */
export function lifecycleFrameOf(data: unknown): SubagentLifecycleFrame | null {
  const frame = recordOf(data)
  const id = frame === null ? undefined : stringOf(frame, 'id')
  if (frame === null || id === undefined) return null
  const description = stringOf(frame, 'description')
  const status = stringOf(frame, 'status')
  return {
    id,
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
    ...(frame.detached === true ? { detached: true } : {}),
  }
}

/** 进度帧：没有 progress.id 就认不出是哪一行，整帧作废 */
export function progressFrameOf(data: unknown): SubagentProgressFrame | null {
  const frame = recordOf(data)
  const progress = frame === null ? null : recordOf(frame.progress)
  const id = progress === null ? undefined : stringOf(progress, 'id')
  if (frame === null || progress === null || id === undefined) return null
  const status = stringOf(progress, 'status')
  const description = stringOf(progress, 'description')
  const lastIntent = stringOf(progress, 'lastIntent')
  const resolvedModel = stringOf(progress, 'resolvedModel')
  const resolvedThinkingLevel = stringOf(progress, 'resolvedThinkingLevel')
  const recentOutput = Array.isArray(progress.recentOutput)
    ? progress.recentOutput.filter((line): line is string => typeof line === 'string')
    : undefined
  const task = stringOf(frame, 'task')
  return {
    ...(task === undefined ? {} : { task }),
    ...(frame.detached === true ? { detached: true } : {}),
    progress: {
      id,
      ...(status === undefined ? {} : { status }),
      ...(description === undefined ? {} : { description }),
      ...(lastIntent === undefined ? {} : { lastIntent }),
      ...(resolvedModel === undefined ? {} : { resolvedModel }),
      ...(resolvedThinkingLevel === undefined ? {} : { resolvedThinkingLevel }),
      ...(recentOutput === undefined ? {} : { recentOutput }),
    },
  }
}

/**
 * omp 的 status 词 → transcript 的 TaskState 词，逐档对应：
 * aborted 是「人把它停了」，落到 killed（timed_out 说的是超时，那是另一件事）。认不出返回 null，整帧不落。
 */
export function taskStateOf(status: string | undefined): TranscriptTask['state'] | null {
  switch (status) {
    case 'started':
    case 'running':
      return 'running'
    case 'completed':
      return 'completed'
    case 'failed':
      return 'failed'
    case 'aborted':
      return 'killed'
    default:
      return null
  }
}

/** 终态：到了就不再变（迟到的进度帧不许把一行已结的账改回运行中） */
function isTerminal(state: TranscriptTask['state']): boolean {
  return state !== 'running'
}

export interface SubagentLedgerOptions {
  /** 时刻由调用方给：单测钉得住，进程里也只有一处时钟 */
  readonly now: () => number
}

/**
 * 子代理账：id → 那一行 task。去重是必需的：omp 的进度帧每 150ms 一条，
 * 原样转发就是每 150ms 一次整格替换；只有投影结果真的变了才交 ops。
 */
export class SubagentLedger {
  private readonly tasksById = new Map<string, TranscriptTask>()

  constructor(private readonly o: SubagentLedgerOptions) {}

  get tasks(): readonly TranscriptTask[] {
    return [...this.tasksById.values()]
  }

  /** 一条生命周期帧 → 一行 task；认不出状态、或已结后又来的非终态，都交空表 */
  lifecycle(data: unknown): TranscriptOperation[] {
    const frame = lifecycleFrameOf(data)
    if (frame === null) return []
    const state = taskStateOf(frame.status)
    if (state === null) return []
    const previous = this.tasksById.get(frame.id)
    // 已结的行不许被翻回运行中：omp 会补发迟到的帧
    if (previous !== undefined && isTerminal(previous.state) && !isTerminal(state)) return []
    const stamp = iso(this.o.now())
    const startedAt = previous?.startedAt ?? stamp
    return this.commit({
      taskId: frame.id,
      kind: 'subagent',
      state,
      detached: frame.detached === true,
      // omp 的 lifecycle id 就是它给这个子代理签的输出号，所以 agentId 与 taskId 同值
      agentId: frame.id,
      description: frame.description ?? previous?.description ?? frame.id,
      outputTail: previous?.outputTail ?? '',
      startedAt,
      ...(isTerminal(state) ? { endedAt: stamp } : {}),
      ...(previous?.model === undefined ? {} : { model: previous.model }),
      ...(previous?.thinkingEffort === undefined ? {} : { thinkingEffort: previous.thinkingEffort }),
    })
  }

  /**
   * 一条进度帧 → 那一行的最新投影。进度帧只带指标不带生死：状态沿用上一帧
   * （没有上一帧时按 running —— 进度先于生命周期到达只可能是重连）。
   */
  progress(data: unknown): TranscriptOperation[] {
    const frame = progressFrameOf(data)
    const id = frame?.progress?.id
    if (frame === null || id === undefined) return []
    const previous = this.tasksById.get(id)
    const reported = frame.progress?.status === undefined ? null : taskStateOf(frame.progress.status)
    const state = previous?.state ?? reported ?? 'running'
    // 已结的行不再改写：omp 的收尾进度帧会在生命周期之后到
    if (previous !== undefined && isTerminal(previous.state)) return []
    const output = frame.progress?.recentOutput
    const outputTail = Array.isArray(output) ? output.join('\n') : (previous?.outputTail ?? '')
    const description = frame.progress?.description ?? frame.progress?.lastIntent ?? frame.task ?? previous?.description
    return this.commit({
      taskId: id,
      kind: 'subagent',
      state,
      detached: frame.detached === true || previous?.detached === true,
      description: description ?? previous?.description ?? id,
      outputTail,
      startedAt: previous?.startedAt ?? iso(this.o.now()),
      ...(previous?.endedAt === undefined ? {} : { endedAt: previous.endedAt }),
      ...(typeof frame.progress?.resolvedModel === 'string'
        ? { model: frame.progress.resolvedModel }
        : previous?.model === undefined
          ? {}
          : { model: previous.model }),
      ...(typeof frame.progress?.resolvedThinkingLevel === 'string'
        ? { thinkingEffort: frame.progress.resolvedThinkingLevel }
        : previous?.thinkingEffort === undefined
          ? {}
          : { thinkingEffort: previous.thinkingEffort }),
    })
  }

  /** 唯一的写点：整格替换前先比一次，没变就不发 */
  private commit(task: TranscriptTask): TranscriptOperation[] {
    if (sameTask(this.tasksById.get(task.taskId), task)) return []
    this.tasksById.set(task.taskId, task)
    return [{ op: 'task.upsert', task }]
  }
}

function sameTask(left: TranscriptTask | undefined, right: TranscriptTask): boolean {
  if (left === undefined) return false
  return (
    left.state === right.state &&
    left.detached === right.detached &&
    left.description === right.description &&
    left.outputTail === right.outputTail &&
    left.startedAt === right.startedAt &&
    left.endedAt === right.endedAt &&
    left.model === right.model &&
    left.thinkingEffort === right.thinkingEffort &&
    left.error === right.error
  )
}

function iso(ms: number): string {
  return new Date(ms).toISOString()
}
