import {
  applyOps,
  emptyTimeline,
  frameId,
  pageFromState,
  stepId,
  type TranscriptOperation,
  type TranscriptPage,
  turnId,
} from '@poietica/transcript'

/** omp 的消息形状（只取投影要读的那几格，避免绑到 omp 的深层类型） */
export interface OmpMessage {
  readonly role?: string
  readonly timestamp?: number
  readonly content?: unknown
  readonly customType?: string
  readonly attribution?: string
  readonly details?: unknown
  readonly display?: boolean
  readonly toolCallId?: string
  readonly isError?: boolean
  readonly summary?: string
}

export interface HistoryPageOptions {
  /** 一页多少轮（默认 20） */
  readonly pageSize?: number
  /** 已经是当前那一轮：留 running（屏幕上的封条还在转） */
  readonly isTurnOpen?: boolean
}

interface ScreenResult {
  readonly content: unknown
  readonly details: unknown
  readonly isError: boolean
}

interface OpenTurn {
  readonly opening: OmpMessage
  readonly prompt: OmpMessage | null
  readonly steps: OmpMessage[]
}

interface ScreenTurn {
  readonly turn: number
  readonly opening: OmpMessage
  readonly prompt: OmpMessage | null
  readonly steps: readonly OmpMessage[]
  readonly openedAt: string
  readonly endedAt: string | null
  readonly state: 'running' | 'completed'
  readonly results: ReadonlyMap<string, ScreenResult>
}

type ScreenBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'thinking'; readonly text: string }
  | { readonly kind: 'tool'; readonly callId: string; readonly name: string; readonly arguments: unknown }

/**
 * 历史分页（12 页 §9.2，迁移自 legacy bridge.ts 的 screenTurns / groupTurns / turnOps）。
 *
 * **一轮从「人说的话」开始，到下一句人话为止**——与增量那条路同一个判据。一次 omp turn 里模型会跑好几趟，
 * 「一条消息一格」会把一次对话拆成好几行；这里按人话归拢，assistant 消息各占一个段，工具结果并回发起它的那次调用。
 *
 * 删掉了 legacy 的镜像机制（transcript-mirror、warmScreen、restage）：分页直接从 omp 的会话消息算，
 * Core 不保存第二份正文，所以不存在两份数据不一致的问题。
 */
export function projectHistoryPage(
  messages: readonly OmpMessage[],
  beforeTurnId: string | null,
  o: HistoryPageOptions = {},
): TranscriptPage {
  const pageSize = o.pageSize ?? 20
  const turns = screenTurns(messages, o.isTurnOpen === true)
  const before = beforeTurnId === null ? Number.POSITIVE_INFINITY : turnOrdinalOf(beforeTurnId)
  const older = turns.filter((entry) => entry.turn < before)
  const window = older.slice(Math.max(0, older.length - pageSize))
  const ops = window.flatMap((entry) => screenOps(entry))
  const items = itemsFromOps(ops)
  return {
    items,
    tasks: [],
    interactions: [],
    attachments: attachmentsFrom(ops),
    todos: [],
    prompts: [],
    meta: {},
    hasMoreOlder: older.length > window.length,
  }
}

/** 历史里最后一轮的序号；重开会话时交给 LiveProjector.seat */
export function lastTurnOrdinal(messages: readonly OmpMessage[]): number {
  const turns = screenTurns(messages, false)
  return turns.at(-1)?.turn ?? 0
}

function turnOrdinalOf(id: string): number {
  const n = Number(id.replace(/^t/, ''))
  return Number.isFinite(n) ? n : 0
}

function screenTurns(messages: readonly OmpMessage[], isTurnOpen: boolean): ScreenTurn[] {
  const results = resultsOf(messages)
  const turns: ScreenTurn[] = []
  let open: OpenTurn | null = null
  const seal = (): void => {
    if (open === null) return
    const held = open
    open = null
    const turn = turns.length + 1
    const last = held.steps.at(-1) ?? null
    turns.push({
      turn,
      opening: held.opening,
      prompt: held.prompt,
      steps: held.steps,
      openedAt: stampOf(held.prompt ?? held.opening),
      endedAt: last === null ? null : stampOf(last),
      state: 'completed',
      results,
    })
  }
  for (const message of messages) {
    if (message.role === 'toolResult' || !isVisible(message)) continue
    const opens = message.role === 'user' || isSkillTurn(message)
    const starts = opens || message.role === 'compactionSummary'
    if (starts || open === null) {
      seal()
      const next: OpenTurn = { opening: message, prompt: opens ? message : null, steps: [] }
      open = next
      if (!starts) next.steps.push(message)
      continue
    }
    open.steps.push(message)
  }
  seal()
  const newest = turns.at(-1)
  return newest !== undefined && isTurnOpen
    ? [...turns.slice(0, -1), { ...newest, state: 'running', endedAt: null }]
    : turns
}

function resultsOf(messages: readonly OmpMessage[]): Map<string, ScreenResult> {
  const results = new Map<string, ScreenResult>()
  for (const message of messages) {
    if (message.role !== 'toolResult') continue
    const callId = message.toolCallId
    if (typeof callId === 'string' && callId !== '') {
      results.set(callId, { content: message.content, details: message.details, isError: message.isError === true })
    }
  }
  return results
}

/** omp 给合成的横幅打了 display: false（目标模式的 <goal_context>）——它是给模型看的上下文，不是用户说过的话 */
function isVisible(message: OmpMessage): boolean {
  return message.display !== false
}

const SKILL_PROMPT_MESSAGE_TYPE = 'skill-prompt'

/** 用户自己发起的技能轮：类型 + 归属两格都对才算（自动加载的技能是 agent 自己塞的上下文） */
function isSkillTurn(message: OmpMessage): boolean {
  return message.customType === SKILL_PROMPT_MESSAGE_TYPE && message.attribution === 'user'
}

function screenOps(entry: ScreenTurn): TranscriptOperation[] {
  return entry.opening.role === 'compactionSummary' ? compactionOps(entry) : turnOps(entry)
}

/** 压缩那一格：号按轮走（compaction-<轮号>），live 的开门/关门两次 upsert 也落在同一格上 */
function compactionOps(entry: ScreenTurn): TranscriptOperation[] {
  const payload: Record<string, unknown> = { state: entry.state === 'running' ? 'running' : 'completed' }
  if (typeof entry.opening.summary === 'string' && entry.opening.summary !== '') payload.summary = entry.opening.summary
  return [
    {
      op: 'marker.upsert',
      item: {
        kind: 'marker',
        markerId: `compaction-${String(entry.turn)}`,
        marker: 'compaction',
        at: entry.openedAt,
        payload,
      },
    },
  ]
}

function turnOps(entry: ScreenTurn): TranscriptOperation[] {
  const turn = turnId(entry.turn)
  const ops: TranscriptOperation[] = [
    turnOp(entry),
    ...imagesOf(entry.prompt === null ? undefined : entry.prompt.content, entry.openedAt),
  ]
  let step = 0
  for (const message of entry.steps) {
    const at = stampOf(message)
    const blocks = contentOf(message)
    let frame = 0
    if (blocks.length === 0) continue
    ops.push(stepOp(turn, step, 'completed', at, at))
    for (const block of blocks) {
      if (block.kind === 'tool') {
        // 一次工具调用占一个新段：入参与结果分成两段会被投影层认成两次调用
        if (frame > 0) {
          step += 1
          frame = 0
          ops.push(stepOp(turn, step, 'completed', at, at))
        }
        ops.push(toolOp(turn, step, block, entry.results.get(block.callId)))
        continue
      }
      ops.push(frameOp(turn, step, frame, block))
      frame += 1
    }
    step += 1
  }
  return entry.state === 'running' ? markLastStepRunning(ops, turn) : ops
}

/** 只有最后一个段能在跑着的时候留 running：段永远停在进行中，屏幕上那一行就一直转 */
function markLastStepRunning(ops: TranscriptOperation[], turn: string): TranscriptOperation[] {
  const at = ops.findLastIndex((op) => op.op === 'step.upsert' && op.turnId === turn)
  if (at < 0) return ops
  return ops.map((op, index): TranscriptOperation => {
    if (index !== at || op.op !== 'step.upsert') return op
    const { endedAt: _dropped, ...rest } = op.step
    return { ...op, step: { ...rest, state: 'running' } }
  })
}

function turnOp(entry: ScreenTurn): TranscriptOperation {
  const skills = entry.prompt === null ? [] : skillActivationsOf(entry.prompt)
  return {
    op: 'turn.upsert',
    turn: {
      kind: 'turn',
      turnId: turnId(entry.turn),
      ordinal: entry.turn,
      state: entry.state,
      origin:
        skills.length === 0
          ? { kind: 'user' }
          : { kind: 'user', payload: { kind: 'skill_activation', trigger: 'user-slash', skillActivations: skills } },
      ...(entry.prompt === null ? {} : { prompt: promptTextOf(entry.prompt) }),
      startedAt: entry.openedAt,
      ...(entry.endedAt === null ? {} : { endedAt: entry.endedAt }),
    },
  }
}

function skillActivationsOf(message: OmpMessage): readonly { skillName: string }[] {
  const name = detailsField(message, 'name')
  return typeof name === 'string' && name !== '' ? [{ skillName: name }] : []
}

function promptTextOf(message: OmpMessage): string {
  const prompt = detailsField(message, 'prompt')
  const args = detailsField(message, 'args')
  if (typeof prompt === 'string' && prompt !== '') return prompt
  if (typeof args === 'string' && args !== '') return args
  return textOf(message.content)
}

function detailsField(message: OmpMessage, key: string): unknown {
  const details = message.details
  return typeof details === 'object' && details !== null ? Reflect.get(details, key) : undefined
}

function stepOp(
  turn: string,
  ordinal: number,
  state: 'running' | 'completed',
  startedAt: string,
  endedAt: string,
): TranscriptOperation {
  return {
    op: 'step.upsert',
    turnId: turn,
    step: { kind: 'step', stepId: stepId(turn, ordinal), turnId: turn, ordinal, state, startedAt, endedAt },
  }
}

function frameOp(
  turn: string,
  step: number,
  frame: number,
  block: Extract<ScreenBlock, { kind: 'text' | 'thinking' }>,
): TranscriptOperation {
  const id = frameId(stepId(turn, step), frame)
  return {
    op: 'frame.upsert',
    turnId: turn,
    stepId: stepId(turn, step),
    frame:
      block.kind === 'text'
        ? { kind: 'text', role: 'assistant', frameId: id, text: block.text }
        : { kind: 'thinking', frameId: id, text: block.text },
  }
}

/** 一次工具调用：调用与结果同一帧（同一个 frameId 的两次 upsert）；details 必须带上 */
function toolOp(
  turn: string,
  step: number,
  block: Extract<ScreenBlock, { kind: 'tool' }>,
  result: ScreenResult | undefined,
): TranscriptOperation {
  return {
    op: 'frame.upsert',
    turnId: turn,
    stepId: stepId(turn, step),
    frame: {
      kind: 'tool',
      frameId: `tool.${block.callId}`,
      toolCallId: block.callId,
      name: block.name,
      state: result === undefined ? 'running' : result.isError ? 'error' : 'done',
      input: block.arguments,
      ...(result === undefined
        ? {}
        : {
            output: { content: result.content, details: result.details },
            ...(result.isError ? { error: textOf(result.content) } : {}),
          }),
    },
  }
}

function contentOf(message: OmpMessage): readonly ScreenBlock[] {
  const content = message.content
  if (typeof content === 'string') return content === '' ? [] : [{ kind: 'text', text: content }]
  if (!Array.isArray(content)) return []
  const blocks: ScreenBlock[] = []
  for (const value of content as readonly Record<string, unknown>[]) {
    const parsed = blockOf(value)
    if (parsed !== undefined) blocks.push(parsed)
  }
  return blocks
}

function blockOf(block: Record<string, unknown>): ScreenBlock | undefined {
  const kind = block.type
  if (kind === 'text' && typeof block.text === 'string' && block.text !== '') {
    return { kind: 'text', text: block.text }
  }
  if (kind === 'thinking' && typeof block.thinking === 'string' && block.thinking !== '') {
    return { kind: 'thinking', text: block.thinking }
  }
  if (kind === 'toolCall' && typeof block.id === 'string' && block.id !== '') {
    return {
      kind: 'tool',
      callId: block.id,
      name: typeof block.name === 'string' ? block.name : '',
      arguments: block.arguments,
    }
  }
  return undefined
}

/** 正文帧只装文字：图片块另走 attachmentOp */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return (value as readonly { readonly type?: unknown; readonly text?: unknown }[])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')
}

/**
 * 用户消息里的图片。omp 读会话时已把 blob 换回内联 base64，所以像素此刻就在手上。
 * 号必须跨消息唯一：号里带上这条消息的时刻，否则两条各带一张图的用户消息会撞号、后一张覆盖前一张。
 */
function imagesOf(content: unknown, stamp: string): TranscriptOperation[] {
  if (!Array.isArray(content)) return []
  const ops: TranscriptOperation[] = []
  for (const [index, value] of content.entries()) {
    const block = value as { readonly type?: unknown; readonly data?: unknown; readonly mimeType?: unknown }
    if (block.type !== 'image' || typeof block.data !== 'string' || block.data === '') continue
    const mediaType = typeof block.mimeType === 'string' ? block.mimeType : 'image/png'
    const attachmentId = `${stamp}#${String(index)}`
    ops.push({
      op: 'attachment.upsert',
      attachment: {
        attachmentId,
        mediaType,
        source: {
          kind: 'url',
          url: block.data.startsWith('data:') ? block.data : `data:${mediaType};base64,${block.data}`,
        },
      },
    })
  }
  return ops
}

function stampOf(message: OmpMessage): string {
  return typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString()
    : new Date(0).toISOString()
}

/** 用 transcript 的折叠器把 ops 变成 items：step/frame 的嵌套与覆盖由它负责，这里不写第二份 */
function itemsFromOps(ops: readonly TranscriptOperation[]): TranscriptPage['items'] {
  return pageFromState(applyOps(emptyTimeline(), ops)).items
}
function attachmentsFrom(ops: readonly TranscriptOperation[]): TranscriptPage['attachments'] {
  return ops.flatMap((op) => (op.op === 'attachment.upsert' ? [op.attachment] : []))
}
