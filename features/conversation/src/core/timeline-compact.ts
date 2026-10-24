import { assertNever } from '@poietica/foundation'
import type { TranscriptOperation } from '@poietica/transcript'

/*
 * 时间线批内压缩（P-05）。
 *
 * 生产者按事件吐 op：文本每个 token 一条 append，工具每块输出一条带完整尾部输出（omp 每块都发
 * ≤50KB 的整份尾缓冲）的 frame.upsert。通道 16ms 合一批，但之前原样发出 —— 同一格的前几份立刻
 * 被最后一份覆盖，却照样走完 JSON 序列化、两次跨进程、结构化克隆与逐条应用。这里在发出前只做
 * **可证明等价**的两种合并：
 *
 *   A. 紧邻、同目标、offset 首尾相接的 append 拼成一条（appendAtOffset 的重叠 / 缺口判据对拼接
 *      前后给出同样的结论）；
 *   B. 同一个键的整格替换（frame.upsert 按 turn/step/frame，task.upsert 按 taskId）：后一条的
 *      内容放进前一条的槽位，后一条不再单独出现。位置用旧的：帧在 step 里的顺序、任务在表里
 *      的顺序都由**第一次插入**决定；中间那些 op 只要不碰这个键，就与它可交换。
 */

type Op = TranscriptOperation
type AppendOp = Extract<Op, { op: 'append' }>

/** 往回找同键 upsert 的最远距离：保证整批 O(n)，正常批次远小于它 */
export const COMPACT_LOOKBACK = 64

/** 一格帧的键（与 timeline-channel 的节流共用） */
export const frameKey = (turnId: string, stepId: string, frameId: string): string =>
  `f\u0000${turnId}\u0000${stepId}\u0000${frameId}`

const taskKey = (taskId: string): string => `t\u0000${taskId}`

/** append 写的是哪一格 */
function appendKey(op: AppendOp): string {
  return op.target.type === 'task'
    ? taskKey(op.target.taskId)
    : frameKey(op.target.turnId, op.target.stepId, op.target.frameId)
}

/** 整格替换型 op 的键；不是这一类就是 undefined */
export function replaceKey(op: Op): string | undefined {
  if (op.op === 'frame.upsert') return frameKey(op.turnId, op.stepId, op.frame.frameId)
  if (op.op === 'task.upsert') return taskKey(op.task.taskId)
  return undefined
}

/*
 * 能不能和「键为 key 的整格替换」交换先后。
 *
 * reset 换掉整份状态、items.remove 会删掉整轮（连同其中的帧）：之前与之后不可互换。
 * append 写到这一格上时顺序有意义（先替换再追加 ≠ 先追加再替换）。
 * turn / step 的 upsert 只换头部、保留已有子项（apply.ts applyTurnUpsert / applyStepUpsert），
 * 帧插入时缺 turn / step 会先建骨架 —— 两种先后的结果相同，所以可交换。
 * 穷尽 switch：上游新增 op 类型时这里编译不过，逼着先想清楚它会不会删除 / 重建格子。
 */
function commutes(op: Op, key: string): boolean {
  switch (op.op) {
    case 'reset':
    case 'items.remove':
      return false
    case 'append':
      return appendKey(op) !== key
    case 'frame.upsert':
    case 'task.upsert':
      return replaceKey(op) !== key
    case 'turn.upsert':
    case 'step.upsert':
    case 'marker.upsert':
    case 'taskref.upsert':
    case 'interaction.upsert':
    case 'attachment.upsert':
    case 'todo.upsert':
    case 'prompt.upsert':
    case 'meta.merge':
      return true
    default:
      return assertNever(op)
  }
}

/** 规则 A：能接到 last 后面就交回拼好的那一条 */
function joined(last: Op | undefined, op: AppendOp): AppendOp | undefined {
  if (last?.op !== 'append' || appendKey(last) !== appendKey(op)) return undefined
  if (op.offset !== last.offset + last.text.length) return undefined
  return { ...last, text: last.text + op.text }
}

/**
 * 规则 B：往回找同键的那一槽；中途遇到不可交换的就放弃。
 *
 * 键跟着 out 逐格并排存（`heldKeys`），**一格里只算一次**：从前每回看一格都要重新拼一遍键
 * （拼字符串 + 每次新建四个字符串的比较），工具输出一大，一批就是几千条 op、每批 16ms 一次，
 * 在 Core 里是实打实的固定开销。并排那张表与 out 永远同长同序。
 */
function slotOf(out: readonly Op[], keys: readonly (string | undefined)[], key: string): number {
  const stop = Math.max(0, out.length - COMPACT_LOOKBACK)
  for (let at = out.length - 1; at >= stop; at -= 1) {
    const prior = out[at]
    if (prior === undefined) break
    /* 并排表的键就是这一格的替换键：相等即命中；append 那一格不进这张表，因此不会被误认。 */
    if (keys[at] === key) return at
    if (!commutes(prior, key)) break
  }
  return -1
}

/**
 * 批内压缩。输入不修改；什么都没合并时交回原数组（引用相同）。
 */
export function compactOps(ops: readonly Op[]): readonly Op[] {
  if (ops.length < 2) return ops
  const out: Op[] = []
  const keys: (string | undefined)[] = []
  let changed = false
  for (const op of ops) {
    const appended = op.op === 'append' ? joined(out.at(-1), op) : undefined
    if (appended !== undefined) {
      out[out.length - 1] = appended
      changed = true
      continue
    }
    const key = replaceKey(op)
    const slot = key === undefined ? -1 : slotOf(out, keys, key)
    if (slot >= 0) {
      out[slot] = op
      changed = true
      continue
    }
    out.push(op)
    keys.push(key)
  }
  return changed ? out : ops
}

/** 非正文 op 的估算字符数：只为环形缓存的预算，量级对就行 */
const SMALL_OP_CHARS = 256

/** 一条 op 大约占多少字符（UTF-16 码元）；给环形缓存的字节预算用 */
function opChars(op: Op): number {
  switch (op.op) {
    case 'append':
      return op.text.length
    case 'frame.upsert':
      if (op.frame.kind === 'text' || op.frame.kind === 'thinking') return op.frame.text.length + SMALL_OP_CHARS
      if (op.frame.kind === 'tool') return jsonChars(op.frame.output) + jsonChars(op.frame.input) + SMALL_OP_CHARS
      return SMALL_OP_CHARS
    case 'task.upsert':
      return op.task.outputTail.length + SMALL_OP_CHARS
    case 'reset':
      return jsonChars(op.snapshot)
    default:
      return SMALL_OP_CHARS
  }
}

function jsonChars(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value === 'string') return value.length
  return JSON.stringify(value)?.length ?? 0
}

export function estimateChars(ops: readonly Op[]): number {
  let total = 0
  for (const op of ops) total += opChars(op)
  return total
}
