import { readFileSync, statSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tagImageAttachmentSource } from '@oh-my-pi/pi-tui/prompt/image-source'
import type { SubmitInput } from '@poietica/engine'
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
   * 直接交给 omp 的图片内容（`ImageContent[]`）：data 与 mimeType 之外，还带上了
   * `tagImageAttachmentSource` 画的落盘路径标记 —— SDK 靠这个符号注入隐藏的
   * image-attachment 伴生消息，agent 于是既拿到像素，也拿到能 `read` 的路径
   * （12 页 §7.6；legacy bridge.ts 第 2204 行同一处）。
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

/** omp 的技能消息类型（与官方 SKILL_PROMPT_MESSAGE_TYPE 同一个值） */
export const SKILL_MESSAGE_TYPE = 'skill-prompt'

/**
 * 一句话交给 omp 时的正文：用户原文 + 每个文件一行 `@<绝对路径>`。
 *
 * turn / steer / followUp 三种投递与队列对账、插话认领都必须用这一份 —— 投递正文
 * 与显示正文（用户原话）是两件事：屏幕上画原文，与 omp 的一切匹配用投递正文。
 */
export function wireTextOf(input: Pick<SubmitInput, 'text' | 'files'>): string {
  const referenced = input.files.map((file) => `@${file.path}`).join('\n')
  return referenced === '' ? input.text : `${input.text}\n${referenced}`
}

/** 用户自己发起的技能消息：类型 + 归属两格都对才算（自动加载的技能是 agent 自己塞的上下文） */
export function isUserSkillMessage(message: {
  readonly customType?: unknown
  readonly attribution?: unknown
}): boolean {
  return message.customType === SKILL_MESSAGE_TYPE && message.attribution === 'user'
}

/**
 * 一次读盘的图片加载（R-08-1）：`submit` 只调它一次，结果同时交给时间线那一帧与
 * omp prompt —— 一张图不再同步读两遍，Core 主线程也不会被大图阻塞。
 *
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
    out.push({ path: image.path, mime: image.mime, base64: (await read(image.path)).toString('base64') })
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
  /**
   * 已经读好的图片（submit 那条路只读一次）。给了就不再碰盘；按 `input.images`
   * 的顺序一一对应（调用方保证同一批）。
   */
  readonly loadedImages?: readonly LoadedImage[]
}

/** expandSkillMessage 的可注入面 */
export interface ExpandSkillOptions {
  /** 会话里当前可用的技能名（omp 的 session.skills）；找不到就报错，不静默 */
  readonly availableSkills: readonly string[]
  /**
   * 把一个技能名展开成要喂给模型的正文（omp 的 `buildSkillPromptMessage` 的产物）。
   * 它要读 SKILL.md，所以是异步；返回 null 表示展开了但没有正文。
   */
  readonly skillMessage: (name: string, args: string) => Promise<{ message: string; details: unknown } | null>
}

/**
 * SubmitInput → omp 输入（12 页 §7.6，迁移自 legacy bridge.ts 的 readPromptImages）。
 *
 * 图片：超过 20 MB 抛 kernel.invalid_params；读文件转 base64（omp 的 ImageContent 只认 base64）。
 * 普通文件：以 @<绝对路径> 的形式逐行附在正文后面（omp 的文件引用约定），由 agent 自己去读。
 *
 * **同步**：不挂技能的那条路必须一路同步走到 `session.prompt()` —— 投递一推迟，屏幕上
 * 那一轮就要等一个额外的刻度才真的开始。技能展开（要读 SKILL.md）是单独的一步，见
 * `expandSkillMessage`。
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
    return { path: image.path, mime: image.mime, base64: read(image.path).toString('base64') }
  })
}

/**
 * 挂上的技能 → 一条 omp 自定义消息（12 页 §7.6，迁移自 legacy bridge.ts 的 expandSkills）。
 *
 * 名字对不上会话自己的技能表时抛 `kernel.not_found`：那一枚 chip 指着一个此刻不存在的技能，
 * 静默丢掉等于「看起来跑了其实没跑」。
 */
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
  return {
    /* 内容 = 各技能块的文本 + 图片（12 页 §7.6）；details 取第一份，与 legacy customSkillMessage 同此 */
    customType: SKILL_MESSAGE_TYPE,
    content: [...blocks.map((block) => ({ type: 'text' as const, text: block.message })), ...imageContents],
    display: true,
    details: blocks[0]?.details,
    attribution: 'user',
  }
}
