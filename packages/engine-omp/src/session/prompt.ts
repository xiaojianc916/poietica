import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { isUserInvokedSkillPrompt, SKILL_PROMPT_MESSAGE_TYPE } from '@oh-my-pi/pi-coding-agent/session/messages'
import { tagImageAttachmentSource } from '@oh-my-pi/pi-tui/prompt/image-source'
import type { SubmitInput, TurnContextBlock } from '@poietica/engine'
import { AppError, SystemErrorCode } from '@poietica/foundation'

/** 一张图片超过 20 MB 就拒收：base64 要进上下文，太大等于把一轮直接撑爆 */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

export interface PreparedImage {
  readonly mediaType: string
  readonly base64: string
  readonly path: string
}

/** 已经读进内存的一张图：时间线那一帧与交给 omp 的像素共用同一份 */
export interface LoadedImage {
  readonly path: string
  readonly mime: string
  readonly base64: string
}

export interface PreparedPrompt {
  readonly text: string
  readonly images: readonly PreparedImage[]
  /**
   * 直接交给 omp 的图片内容（`ImageContent[]`）：除 data 与 mimeType 外还带 `tagImageAttachmentSource`
   * 画的落盘路径标记 —— SDK 靠这个符号注入隐藏的 image-attachment 伴生消息，agent 于是既拿到像素，
   * 也拿到能 `read` 的路径。
   */
  readonly imageContents: readonly unknown[]
  readonly skillNames: readonly string[]
}

/** 一次技能投递在 omp 侧的形状（`CustomMessage` 那几格；不改上游的字段名） */
export interface SkillPromptMessage {
  readonly customType: string
  readonly content: readonly unknown[]
  readonly display: boolean
  readonly details: unknown
  readonly attribution: string
}

/** omp 的技能消息类型经官方常量转出（引擎端口与测试用它拼消息，值仍只有一处产地） */
export const SKILL_MESSAGE_TYPE = SKILL_PROMPT_MESSAGE_TYPE

/** omp 目标续跑那条隐藏消息的类型：RpcGoalController 写死的值，goal-host 靠它认出「这是续跑」 */
export const GOAL_CONTINUATION_TYPE = 'goal-continuation'

/** 目标续跑那一轮的开场消息：custom、display:false —— 它不是人话，但它开一轮 */
export function isGoalContinuationMessage(message: {
  readonly role?: unknown
  readonly customType?: unknown
}): boolean {
  return message.role === 'custom' && message.customType === GOAL_CONTINUATION_TYPE
}

/**
 * 一句话交给 omp 时的正文：用户原文 + 每个文件一行 `@"<绝对路径>" (<文件名>)`。投递正文与显示正文
 * 是两件事：屏幕画原文，与 omp 的一切匹配（队列对账、插话认领）用这一份。路径**必须加引号** ——
 * omp 的 `@` 记号只取到空白为止，路径带空格时只认半截、文件读不进来（Windows 路径里不会有 `"`）。
 * 文件名跟在路径后面，是因为会话文件里只有这一句落盘、附件按内容寻址没有名字，重开之后气泡上的
 * 文件记号只能从这里读回（`splitWireText` 是它的逆，两处改一处必须改另一处）；名字里的 `@` 换全角。
 */
export function wireTextOf(input: Pick<SubmitInput, 'text' | 'files' | 'context'>): string {
  const referenced = input.files.map((file) => `@"${file.path}" (${wireNameOf(file.name)})`).join('\n')
  const lines = referenced === '' ? [input.text] : [input.text, referenced]
  for (const block of input.context ?? []) lines.push(contextBlockOf(block))
  return lines.join('\n')
}

/**
 * omp 队列快照里这一项的样子 —— 与投递正文**不是**同一份字符串：omp 的 `queueChipText` 取消息里
 * 第一段文字，没有文字、只带图的 user 消息报成 `[Image]`。队列对账必须按它比：按投递正文比，纯图
 * 那一句在下一帧 queue_update 里就对不上，被当成「omp 已取走」—— 提前报送达、队列条上消失。
 * 撤回与 message_start 认领仍认投递正文。
 */
export const QUEUE_IMAGE_CHIP = '[Image]'

export function queueChipOf(wireText: string, imageCount: number): string {
  if (wireText !== '') return wireText
  return imageCount > 0 ? QUEUE_IMAGE_CHIP : ''
}

/*
 * 附带上下文（`SubmitInput.context`）在投递正文里的写法：文件引用之后每块一段
 * `<poietica-context source="…">…</poietica-context>`，开闭标签各占整行。
 * 正文里的 `<` 换成 `&lt;`：任何一行都不可能被认成标签，`splitWireText` 从末尾倒着摘也就摘不错；
 * 来源名只留小写字母、数字与连字符。会话文件里落盘的就是这一份，重开时由 `splitWireText` 摘掉。
 */
const CONTEXT_OPEN = /^<poietica-context source="[a-z0-9-]+">$/u
const CONTEXT_CLOSE = '</poietica-context>'

export function contextBlockOf(block: TurnContextBlock): string {
  const source = block.source.toLowerCase().replace(/[^a-z0-9-]/gu, '-') || 'context'
  return `<poietica-context source="${source}">\n${block.text.replaceAll('<', '&lt;')}\n${CONTEXT_CLOSE}`
}

/** 末尾连续的上下文块从第几行开始（没有就是 lines.length）。第 0 行永远是原文，不参与 */
function contextStartOf(lines: readonly string[]): number {
  let end = lines.length
  while (end > 2 && lines[end - 1] === CONTEXT_CLOSE) {
    let open = end - 2
    while (open >= 1 && !CONTEXT_OPEN.test(lines[open] ?? '')) open -= 1
    if (open < 1) break
    end = open
  }
  return end
}

function wireNameOf(name: string): string {
  const flat = name.replace(/\s+/gu, ' ').replaceAll('@', '＠').trim()
  return flat === '' ? 'file' : flat
}

/**
 * 投递正文末尾的一行文件引用：路径带引号、后面跟名字 —— 与 `wireTextOf` 写出去的是同一个形状。
 * 名字必填：写的那一侧每一行都带它，认的这一侧按同一条规矩读，读不出名字的行就不算文件引用。
 */
const QUOTED_REFERENCE = /^@"([^"]+)" \((.+)\)$/u

export interface WireFile {
  readonly path: string
  readonly name: string
}

function referenceOf(line: string): WireFile | null {
  const quoted = QUOTED_REFERENCE.exec(line)
  return quoted === null ? null : { path: quoted[1]!, name: quoted[2]! }
}

/**
 * `wireTextOf` 的逆：从会话文件里那句投递正文摘回用户原文与它带的文件（附带上下文整段丢掉）。只摘**末尾**连续的引用行，
 * 且第一行永远是原文（原文为空时它是空行）—— 用户自己在句中写的 `@路径` 不会被当成附件吞掉。
 */
export function splitWireText(wire: string): { readonly text: string; readonly files: readonly WireFile[] } {
  const all = wire.split('\n')
  /* 上下文块在文件引用之后：先摘它，再摘文件行 */
  const lines = all.slice(0, contextStartOf(all))
  const files: WireFile[] = []
  let end = lines.length
  while (end > 1) {
    const file = referenceOf(lines[end - 1] ?? '')
    if (file === null) break
    files.unshift(file)
    end -= 1
  }
  if (files.length === 0 && lines.length === all.length) return { text: wire, files }
  return { text: lines.slice(0, end).join('\n'), files }
}

/** 用户自己发起的技能消息：类型 + 归属两格都对才算（自动加载的技能是 agent 自己塞的上下文） */
export function isUserSkillMessage(message: {
  readonly customType?: unknown
  readonly attribution?: unknown
}): boolean {
  /* 改用 omp 官方判据（同一份 `customType === SKILL_PROMPT_MESSAGE_TYPE && attribution === 'user'`）：
   * 上游改了值的定义或加了新档，这里跟着走，不必回来改第二处。 */
  return isUserInvokedSkillPrompt(message as never)
}

/**
 * `submit` 只调它一次，结果同时交给时间线那一帧与 omp prompt —— 一张图不再同步读两遍。
 * 超过 20 MB 抛 kernel.invalid_params（先看 stat，不读大文件）；读不到原样抛错。
 */
export interface LoadImagesOptions {
  readonly readFile?: (path: string) => Promise<Buffer>
  readonly statSize?: (path: string) => number
}

export async function loadImages(
  images: readonly { readonly path: string; readonly mime: string }[],
  o: LoadImagesOptions = {},
): Promise<LoadedImage[]> {
  const statSize = o.statSize ?? ((p: string) => statSync(p).size)
  const read = o.readFile ?? ((p: string) => readFile(p))
  const out: LoadedImage[] = []
  for (const image of images) {
    const size = statSize(image.path)
    if (size > MAX_IMAGE_BYTES) {
      throw new AppError(SystemErrorCode.invalidParams, `图片超过 20 MB：${image.path}`)
    }
    out.push({ path: image.path, mime: image.mime, base64: (await read(image.path)).toBase64() })
  }
  return out
}

/** 已读好的图 → omp 的图片内容块（带落盘路径标记，SDK 靠它注入伴生消息） */
export function imageContentsOf(images: readonly LoadedImage[]): unknown[] {
  return images.map((image) =>
    tagImageAttachmentSource({ type: 'image', data: image.base64, mimeType: image.mime }, image.path, 'image'),
  )
}

/** preparePrompt 的可注入面（测试用：不起进程、不碰磁盘） */
export interface PreparePromptOptions {
  readonly readFile?: (path: string) => Buffer
  readonly statSize?: (path: string) => number
  /** 已经读好的图片（`submit` 那条路只读一次）。给了就不再碰盘；按 `input.images` 的顺序一一对应 */
  readonly loadedImages?: readonly LoadedImage[]
}

/** expandSkillMessage 的可注入面 */
export interface ExpandSkillOptions {
  /** 会话里当前可用的技能名（omp 的 session.skills）；找不到就报错，不静默 */
  readonly availableSkills: readonly string[]
  /** 把一个技能名展开成要喂给模型的正文（omp 的 `buildSkillPromptMessage`）；要读 SKILL.md，所以是异步 */
  readonly skillMessage: (name: string, args: string) => Promise<{ message: string; details: unknown } | null>
}

/**
 * 图片超过 20 MB 抛 kernel.invalid_params、读文件转 base64；普通文件以 @<绝对路径> 逐行附在正文后面。
 * **同步**：不挂技能的那条路必须一路同步走到 `session.prompt()` —— 投递一推迟，屏幕上那一轮就要多等一个刻度。
 */
export function preparePrompt(input: SubmitInput, o: PreparePromptOptions): PreparedPrompt {
  const loaded = o.loadedImages ?? readImagesSync(input.images, o)
  const images: PreparedImage[] = loaded.map((image) => ({
    mediaType: image.mime,
    base64: image.base64,
    path: image.path,
  }))
  const imageContents = imageContentsOf(loaded)
  const text = wireTextOf(input)
  const skillNames = [...input.skills]
  return { text, images, imageContents, skillNames }
}

/** 同步读一组图（steer / followUp 那条路；turn 那条路走 loadImages 只读一次） */
function readImagesSync(
  images: readonly { readonly path: string; readonly mime: string }[],
  o: PreparePromptOptions,
): LoadedImage[] {
  const statSize = o.statSize ?? ((p: string) => statSync(p).size)
  const read = o.readFile ?? ((p: string) => readFileSync(p))
  return images.map((image) => {
    const size = statSize(image.path)
    if (size > MAX_IMAGE_BYTES) {
      throw new AppError(SystemErrorCode.invalidParams, `图片超过 20 MB：${image.path}`)
    }
    return { path: image.path, mime: image.mime, base64: read(image.path).toBase64() }
  })
}

/** 名字对不上会话自己的技能表时抛 `kernel.not_found`：静默丢掉等于「看起来跑了其实没跑」 */
export async function expandSkillMessage(
  input: SubmitInput,
  imageContents: readonly unknown[],
  o: ExpandSkillOptions,
): Promise<SkillPromptMessage | null> {
  if (input.skills.length === 0) return null
  const blocks: { message: string; details: unknown }[] = []
  for (const name of input.skills) {
    if (!o.availableSkills.includes(name)) {
      throw new AppError(SystemErrorCode.notFound, `这个技能现在不在会话里：${name}`)
    }
    const block = await o.skillMessage(name, input.text)
    if (block !== null) blocks.push(block)
  }
  if (blocks.length === 0) return null
  /* 技能消息不走 wireTextOf：附带上下文作为额外的文本块交给模型。气泡读 details 里的 prompt / args，不读 content */
  const context = (input.context ?? []).map((block) => ({ type: 'text' as const, text: contextBlockOf(block) }))
  return {
    customType: SKILL_MESSAGE_TYPE,
    content: [...blocks.map((block) => ({ type: 'text' as const, text: block.message })), ...context, ...imageContents],
    display: true,
    details: blocks[0]?.details,
    attribution: 'user',
  }
}
