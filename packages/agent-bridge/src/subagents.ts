/*
 * omp 子代理可观测面 → transcript 的 task 行。
 *
 * omp 把子代理的生死与进度推在**根作用域总线**上（`createAgentSession` 交回的
 * `subagentEventBus`，三个频道见 task/types.ts 与 pi-tui 的 session-observer-registry.ts）。
 * 官方自己的 RPC 宿主正是用它建 RpcSubagentRegistry（modes/rpc/rpc-subagents.ts:107），
 * 我们此前把这个返回值丢掉了 —— 于是 task 工具照常跑，屏幕上一条后台任务都没有：
 * packages/transcript 早钉好了 `task.upsert`（contract/schema.ts 的 transcriptTaskSchema），
 * packages/conversation 也早会画（transcript-projector 的 backgroundOf → 后台任务面板），
 * 缺的只是生产者这一半。
 *
 * 纯状态机，不碰 SDK：事件形状按结构收窄（认不出的格当缺席），能被单测逐条钉住。
 */

import type { TranscriptOperation, TranscriptTask } from '@poietica/transcript'

/*
 * 一条子代理的生命周期帧（pi-tui 的 SubagentLifecyclePayload）。
 *
 * `status` 只有四档；认不出的当缺席整帧不落，不猜成别的 —— 编一个状态比少一行坏得多。
 * 字段一律可选：总线上的载荷是 unknown，收窄在 lifecycleFrameOf 里做一次。
 */
export interface SubagentLifecycleFrame {
  readonly id: string
  readonly description?: string
  readonly status?: string
  readonly detached?: boolean
}

/** 一条进度帧（SubagentProgressPayload）；只列我们真的会读的格。 */
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

/* 只判「是一个对象」：总线上的载荷不可信，逐格取用前先过这一关。 */
function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function stringOf(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]

  return typeof value === 'string' && value !== '' ? value : undefined
}

/** 生命周期帧：号是唯一的必需格，取不到就整帧作废。 */
export function lifecycleFrameOf(data: unknown): SubagentLifecycleFrame | null {
  const frame = recordOf(data)
  const id = frame === null ? undefined : stringOf(frame, 'id')

  if (frame === null || id === undefined) {
    return null
  }

  const description = stringOf(frame, 'description')
  const status = stringOf(frame, 'status')

  return {
    id,
    ...(description === undefined ? {} : { description }),
    ...(status === undefined ? {} : { status }),
    ...(frame['detached'] === true ? { detached: true } : {}),
  }
}

/** 进度帧：没有 `progress.id` 就认不出是哪一行，整帧作废。 */
export function progressFrameOf(data: unknown): SubagentProgressFrame | null {
  const frame = recordOf(data)
  const progress = frame === null ? null : recordOf(frame['progress'])
  const id = progress === null ? undefined : stringOf(progress, 'id')

  if (frame === null || progress === null || id === undefined) {
    return null
  }

  const status = stringOf(progress, 'status')
  const description = stringOf(progress, 'description')
  const lastIntent = stringOf(progress, 'lastIntent')
  const resolvedModel = stringOf(progress, 'resolvedModel')
  const resolvedThinkingLevel = stringOf(progress, 'resolvedThinkingLevel')
  const recentOutput = Array.isArray(progress['recentOutput'])
    ? progress['recentOutput'].filter((line): line is string => typeof line === 'string')
    : undefined
  const task = stringOf(frame, 'task')

  return {
    ...(task === undefined ? {} : { task }),
    ...(frame['detached'] === true ? { detached: true } : {}),
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

/*
 * omp 的 status 词 → transcript 的 TaskState 词。
 *
 * 逐档对应，没有第二套语义：`aborted` 是「人把它停了」，落到 killed（timed_out 说的是
 * 超时，那是另一件事）；started 是 running。认不出返回 null，整帧不落。
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

/** 终态：到了就不再变（迟到的进度帧不许把一行已结的账改回运行中）。 */
function isTerminal(state: TranscriptTask['state']): boolean {
  return state !== 'running'
}

export interface SubagentLedgerOptions {
  /** 时刻由调用方给：单测钉得住，进程里也只有一处时钟。 */
  readonly now: () => number
}

/*
 * 子代理账：id → 那一行 task。
 *
 * 去重是必需的，不是优化：omp 的进度帧每 150ms 一条（executor.ts 的
 * PROGRESS_COALESCE_MS），原样转发就是每 150ms 一次整格替换。只有投影结果真的变了
 * 才交 ops —— 这也是「引用不变则不通知」那条形制在 ops 层的写法。
 */
export class SubagentLedger {
  readonly #now: () => number
  readonly #tasks = new Map<string, TranscriptTask>()

  constructor(options: SubagentLedgerOptions) {
    this.#now = options.now
  }

  get tasks(): readonly TranscriptTask[] {
    return [...this.#tasks.values()]
  }

  /** 一条生命周期帧 → 一行 task；认不出状态、或已结后又来的非终态，都交空表。 */
  lifecycle(data: unknown): TranscriptOperation[] {
    const frame = lifecycleFrameOf(data)

    if (frame === null) {
      return []
    }

    const state = taskStateOf(frame.status)

    if (state === null) {
      return []
    }

    const previous = this.#tasks.get(frame.id)

    /* 已结的行不许被翻回运行中：omp 会补发迟到的帧，那会把屏幕上一行已完成的账改假。 */
    if (previous !== undefined && isTerminal(previous.state) && !isTerminal(state)) {
      return []
    }

    const stamp = iso(this.#now())
    const startedAt = previous?.startedAt ?? stamp

    return this.#commit({
      taskId: frame.id,
      kind: 'subagent',
      state,
      detached: frame.detached === true,
      /*
       * omp 的 lifecycle `id` 就是它给这个子代理签的输出号（AgentOutputManager 分配的
       * `Anna`/`Anna-2`），所以 agentId 与 taskId 同值 —— 如实带上，屏幕那一行才有
       * 可寻址的身份（agent:// 用的也是它）。
       */
      agentId: frame.id,
      description: frame.description ?? previous?.description ?? frame.id,
      outputTail: previous?.outputTail ?? '',
      startedAt,
      ...(isTerminal(state) ? { endedAt: stamp } : {}),
      ...(previous?.model === undefined ? {} : { model: previous.model }),
      ...(previous?.thinkingEffort === undefined
        ? {}
        : { thinkingEffort: previous.thinkingEffort }),
    })
  }

  /**
   * 一条进度帧 → 那一行的最新投影。
   *
   * 进度帧只带指标，不带生死：状态沿用上一帧（没有上一帧时按 running —— 进度先于
   * 生命周期到达只可能是重连，那时这一行确实在跑）。输出尾巴取 omp 自己裁好的
   * recentOutput，不另拼一份。
   */
  progress(data: unknown): TranscriptOperation[] {
    const frame = progressFrameOf(data)
    const id = frame?.progress?.id

    if (frame === null || id === undefined) {
      return []
    }

    const previous = this.#tasks.get(id)
    const reported =
      frame.progress?.status === undefined ? null : taskStateOf(frame.progress.status)
    const state = previous?.state ?? reported ?? 'running'

    /* 已结的行不再改写：omp 的收尾进度帧会在生命周期之后到，改它就是把结果覆盖掉。 */
    if (previous !== undefined && isTerminal(previous.state)) {
      return []
    }

    const output = frame.progress?.recentOutput
    const outputTail = Array.isArray(output) ? output.join('\n') : (previous?.outputTail ?? '')
    const description =
      frame.progress?.description ??
      frame.progress?.lastIntent ??
      frame.task ??
      previous?.description

    return this.#commit({
      taskId: id,
      kind: 'subagent',
      state,
      detached: frame.detached === true || previous?.detached === true,
      description: description ?? previous?.description ?? id,
      outputTail,
      startedAt: previous?.startedAt ?? iso(this.#now()),
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

  /* 唯一的写点：整格替换前先比一次，没变就不发。 */
  #commit(task: TranscriptTask): TranscriptOperation[] {
    if (sameTask(this.#tasks.get(task.taskId), task)) {
      return []
    }

    this.#tasks.set(task.taskId, task)

    return [{ op: 'task.upsert', task }]
  }
}

/* 逐格比：字段少，直接列出来比 JSON 序列化便宜，也不会被键序影响。 */
function sameTask(left: TranscriptTask | undefined, right: TranscriptTask): boolean {
  if (left === undefined) {
    return false
  }

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

const iso = (ms: number): string => new Date(ms).toISOString()
