import { type DiffFile, type DiffStat, diffStatOf } from '@poietica/review'
import type { ToolCallContent } from '../../agent/tool-call'

import { toDiffFiles, toDisplayPath } from './file-diff'
import { type ToolContentPart, toToolContentParts } from './tool-call-content'

// 一次工具调用的两个面（送出/交回），都交 markdown 给同一条渲染管线。
// 送出面优先用投影层映好的 requestContent，缺席才退回入参 JSON；产出同理。
// 图不走 markdown（data URL 会被拦），单独走 images。不截断：长产出由抽屉按行虚拟化。

export interface ToolCallFacetSource {
  readonly requestContent?: readonly ToolCallContent[] | undefined
  readonly content: readonly ToolCallContent[]
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
}

export interface ToolCallFacets {
  readonly diffs: readonly DiffFile[]
  readonly diffStat: DiffStat | null
  /** 这次调用交回来的图，按出现顺序。 */
  readonly images: readonly ToolImage[]
  readonly request: string | null
  readonly response: string | null
}

const INDENT = 2

// 装着 JSON 文档的字符串摊开成文档（避免双重转义压成一行）；不是文档才问是不是路径。
function display(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw
  }

  return readJsonDocument(raw) ?? toDisplayPath(raw)
}

// 全文件唯一把值印成 JSON 源码的地方。
function displayJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key: string, raw: unknown) => display(raw), INDENT)
}

// 围栏得比正文里最长的反引号串还长一格，否则正文会提前收口。
function railFor(body: string, floor: number): string {
  const runs = body.match(/`+/g)
  let longest = 0

  if (runs !== null) {
    for (const run of runs) {
      longest = Math.max(longest, run.length)
    }
  }

  return '`'.repeat(Math.max(floor, longest + 1))
}

function block(lang: string, body: string): string {
  const rail = railFor(body, 3)

  return `${rail}${lang}\n${body}\n${rail}`
}

// block() 的逆运算：交回围栏内行；不是一段机器输出时交回 null。
export function fencedBodyOf(markdown: string): readonly string[] | null {
  const lines = markdown.split('\n')
  const head = lines[0]
  const tail = lines.at(-1)

  if (head === undefined || lines.length < 2) {
    return null
  }

  const open = /^(`{3,})/.exec(head)

  if (open === null || tail !== open[1]) {
    return null
  }

  return lines.slice(1, -1)
}

// 行内代码让反斜杠原样留下，markdown 正文会吃掉它。
function inlineCode(value: string): string {
  if (value === '') {
    return '`""`'
  }

  const rail = railFor(value, 1)
  const pad = value.startsWith('`') || value.endsWith('`') || value.trim() !== value ? ' ' : ''

  return `${rail}${pad}${value}${pad}${rail}`
}

// 只认对象与数组且真解析得动：裸标量重排前后一样，白跑。
function readJsonDocument(text: string): object | null {
  const head = text.trim()

  if (!head.startsWith('{') && !head.startsWith('[')) {
    return null
  }

  try {
    const parsed: unknown = JSON.parse(head)

    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

function prettyJson(text: string): string | null {
  const parsed = readJsonDocument(text)

  return parsed === null ? null : (displayJson(parsed) ?? null)
}

function jsonBlock(value: unknown): string | null {
  try {
    const text: string | undefined = displayJson(value)

    return text === undefined ? null : block('json', text)
  } catch {
    // 循环引用：这一面交不出来，但不能让整张卡片塌。
    return null
  }
}

// 空信封（{}）不算一面。
function isEmptyBag(value: object): boolean {
  return Array.isArray(value) ? value.length === 0 : Reflect.ownKeys(value).length === 0
}

function bagOf(bag: unknown): string | null {
  if (bag === undefined || bag === null) {
    return null
  }

  if (typeof bag === 'object' && isEmptyBag(bag)) {
    return null
  }

  return jsonBlock(bag)
}

function textBlock(text: string): string {
  const pretty = prettyJson(text)

  return pretty === null ? block('text', text) : block('json', pretty)
}

// GFM task list 只有两格，进行中在标题后点出来。
function todoList(items: readonly { readonly title: string; readonly status: string }[]): string {
  return items
    .map((item) => {
      const box = item.status === 'done' ? '- [x]' : '- [ ]'
      const trail = item.status === 'in_progress' ? '（进行中）' : ''

      return `${box} ${item.title}${trail}`
    })
    .join('\n')
}

function partMarkdown(part: Exclude<ToolContentPart, { type: 'diff' }>): string {
  if (part.type === 'text') {
    return textBlock(part.text)
  }

  if (part.type === 'command') {
    return block(part.language, part.command)
  }

  if (part.type === 'prose') {
    // 计划正文本来就是 markdown，包进围栏会把标题与列表符号印出来。
    return part.text
  }

  if (part.type === 'image') {
    return imageMarkdown(part.data, part.mimeType)
  }

  if (part.type === 'todo') {
    return todoList(part.items)
  }

  if (part.type === 'terminal') {
    return `终端 ${inlineCode(part.terminalId)}`
  }

  if (part.type === 'link') {
    // 行内代码而非 markdown 链接：这一面给人读和复制，点不开的锚点不如地址。
    const uri = inlineCode(part.uri)

    return part.name === null ? uri : `${part.name} ${uri}`
  }

  return part.label
}

function imageMarkdown(data: string, mimeType: string): string {
  return `![截图](data:${mimeType};base64,${data})`
}

// omp 产出信封（AgentToolResult 的 content 块数组）在这里拆开：文本接起来，图折成 markdown。
function outputOf(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value === 'string') {
    return value === '' ? null : textBlock(value)
  }

  if (value !== null && typeof value === 'object' && Array.isArray(Reflect.get(value, 'content'))) {
    const blocks = Reflect.get(value, 'content') as readonly {
      type: string
      text?: string
      data?: string
      mimeType?: string
    }[]
    const pieces: string[] = []

    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        pieces.push(block.text)
      } else if (block.type === 'image' && typeof block.data === 'string') {
        pieces.push(imageMarkdown(block.data, block.mimeType ?? 'image/png'))
      }
    }

    return pieces.length === 0 ? null : pieces.join('\n\n')
  }

  return jsonBlock(value)
}

/** 一张要画出来的图。base64 与 mimeType 是它的正本（omp 的 ImageContent）。 */
export interface ToolImage {
  readonly data: string
  readonly mimeType: string
}

const NO_IMAGES: readonly ToolImage[] = []

/**
 * 一面里画得出来的那些片段接成一段 markdown；一段都没有就是 null。
 *
 * 图不在这里：data URL 走 markdown 会被 Streamdown 拦下（它把 data: 当可疑来源，
 * 屏幕上只剩一句「图片被拦截」）。图由 imagesOf 单独交出去，按 <img> 画。
 */
function proseOf(parts: readonly ToolContentPart[]): string | null {
  const pieces: string[] = []

  for (const part of parts) {
    if (part.type !== 'diff' && part.type !== 'image') {
      pieces.push(partMarkdown(part))
    }
  }

  return pieces.length === 0 ? null : pieces.join('\n\n')
}

/** 这一面里的图，按出现顺序。 */
export function imagesOf(parts: readonly ToolContentPart[]): readonly ToolImage[] {
  const shots: ToolImage[] = []

  for (const part of parts) {
    if (part.type === 'image') {
      shots.push({ data: part.data, mimeType: part.mimeType })
    }
  }

  return shots.length === 0 ? NO_IMAGES : shots
}

export function toDiffFilesOf(source: ToolCallFacetSource): readonly DiffFile[] {
  const sent = toDiffFiles(toToolContentParts(source.requestContent))
  const back = toDiffFiles(toToolContentParts(source.content))

  if (sent.length === 0) {
    return back
  }

  return back.length === 0 ? sent : [...sent, ...back]
}

// 三格一趟算完；改动不走 markdown，带行号的统一 diff 才是它的画法（file-diff.ts）。
export function toToolCallFacets(source: ToolCallFacetSource): ToolCallFacets {
  const sent = toToolContentParts(source.requestContent)
  const back = toToolContentParts(source.content)
  const diffs = toDiffFilesOf(source)

  return {
    diffs,
    diffStat: diffStatOf(diffs),
    /** 两面各自的图；data URL 走不了 markdown，所以与 markdown 分开交出去。 */
    images: imagesOf(back),
    request: sent.length === 0 ? bagOf(source.rawInput) : proseOf(sent),
    response: back.length === 0 ? outputOf(source.rawOutput) : proseOf(back),
  }
}
