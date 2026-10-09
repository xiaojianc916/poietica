import { readFileSync, statSync } from 'node:fs'
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

/** preparePrompt 的可注入面（测试用：不起进程、不碰磁盘） */
export interface PreparePromptOptions {
  readonly readFile?: (path: string) => Buffer
  readonly statSize?: (path: string) => number
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
  const statSize = o.statSize ?? ((p: string) => statSync(p).size)
  const read = o.readFile ?? ((p: string) => readFileSync(p))
  const images: PreparedImage[] = []
  const imageContents: unknown[] = []
  for (const image of input.images) {
    const size = statSize(image.path)
    if (size > MAX_IMAGE_BYTES) {
      throw new AppError(SystemErrorCode.invalidParams, `图片超过 20 MB：${image.path}`)
    }
    const base64 = read(image.path).toString('base64')
    images.push({ mediaType: image.mime, base64, path: image.path })
    imageContents.push(
      tagImageAttachmentSource({ type: 'image', data: base64, mimeType: image.mime }, image.path, 'image'),
    )
  }
  const referenced = input.files.map((file) => `@${file.path}`).join('\n')
  const text = referenced === '' ? input.text : `${input.text}\n${referenced}`
  const skillNames = [...input.skills]
  return { text, images, imageContents, skillNames }
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
