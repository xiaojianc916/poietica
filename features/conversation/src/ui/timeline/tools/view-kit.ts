import type { ToolCallContent, ToolDrawerShape, ToolKind } from '@poietica/conversation-kit/model'
import { invariant } from '@poietica/foundation'
import type {
  OmpToolContentBlock,
  OmpToolDetails,
  OmpToolDetailsOf,
  OmpToolInput,
  OmpToolInputOf,
  OmpToolName,
  OmpToolOutput,
  OmpToolOutputOf,
} from '@poietica/omp-types'

// omp 工具调用的因地制宜视图：按工具名查标准答案，认不出的交回空视图由调用方兜底。
// 产出优先于入参（edit/read 的真实内容在产出 details 里）；图片在出口统一追加。
//
// 每一格处理器都拿到自己那个工具的入参与 details 类型（`@poietica/omp-types`）：字段直接读，
// 没有「按名字猜 key」的探针。唯一按名字收窄的地方在 omp-tool-view 的出口（表按名逐格对齐）。

export type { ToolDrawerShape }

export interface OmpToolView {
  readonly known: boolean
  readonly kind: ToolKind
  /*
   * 平时就是帧上的 name；eval 里的 browser / computer prelude 例外 —— 帧上是 eval，跑的是 prelude，
   * 字形按 invokedTool 取，认 eval 会把浏览器操作画成脚本。
   */
  readonly invokedTool: string
  /**
   * omp 自己盖的章 `details.meta.source` 说的 scheme；跑的时候还没有产出，退回入参 path 的 scheme。空串表示不是内部资源。
   */
  readonly scheme: string
  readonly headline: string
  readonly subject: string
  readonly shape: ToolDrawerShape
  readonly background: boolean
  readonly request: readonly ToolCallContent[]
  readonly response: readonly ToolCallContent[]
}

export const NONE: readonly ToolCallContent[] = []

/*
 * 出口反向登记：writeView 要按旧会话里的 `xd://` 设备名再认一次工具（omp 18 的历史数据），
 * 而表在 registry 里、registry 又 import 每个视图文件 —— 直接互相 import 就成环。
 */
export type ViewLookup = (tool: string, input: OmpToolInputOf | undefined, output: OmpToolOutputOf) => OmpToolView

let lookupView: ViewLookup | undefined

export function registerViewLookup(lookup: ViewLookup): void {
  lookupView = lookup
}

export function viewOf(tool: string, input: OmpToolInputOf | undefined, output: OmpToolOutputOf): OmpToolView {
  // 程序不变量：omp-tool-view.ts 在模块求值末尾就登记了出口，视图文件求值之后才会调用。
  invariant(lookupView !== undefined, '视图出口尚未登记')
  return lookupView(tool, input, output)
}

export const text = (body: string): ToolCallContent => ({
  type: 'content',
  content: { type: 'text', text: body },
})
export const prose = (body: string): ToolCallContent => ({ type: 'prose', text: body })
export const code = (body: string, language: string): ToolCallContent => ({
  type: 'command',
  command: body,
  language,
})

export const LINE_CAP = 120

export function oneLine(value: string): string {
  const cut = value.indexOf('\n')
  const said = (cut === -1 ? value : value.slice(0, cut)).trim()

  return said.length > LINE_CAP ? `${said.slice(0, LINE_CAP)}…` : said
}

// 反斜杠才不会被 markdown 当转义吃掉。
export const at = (value: string): string => `\`${value}\``

/**
 * 可选字符串参数「没写」有两种写法：缺字段与空串 —— 模型常把可选参数写成 ""。
 * 判据与 omp 的 schema 一致：空串等于没写。
 */
export const given = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value

/** 「一个或一串」的入参写法（`pr`、`changes`、`type`）：字符串与数组都收成非空列表。 */
export function listOf(value: string | readonly string[] | undefined): readonly string[] {
  if (typeof value === 'string') {
    return value === '' ? [] : [value]
  }

  return (value ?? []).filter((one) => one !== '')
}

export function join(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' ')
}

export function dot(...parts: readonly (string | undefined)[]): string {
  return parts.filter((part): part is string => part !== undefined && part !== '').join(' · ')
}

// read 的路径可能带选择器（src/a.ts:10-20），扩展名要在冒号前收住。
export const LANGS: Readonly<Record<string, string>> = {
  bash: 'bash',
  c: 'c',
  cc: 'cpp',
  cjs: 'javascript',
  cpp: 'cpp',
  cs: 'csharp',
  css: 'css',
  dockerfile: 'docker',
  go: 'go',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  ini: 'ini',
  java: 'java',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'jsx',
  kt: 'kotlin',
  kts: 'kotlin',
  lua: 'lua',
  md: 'markdown',
  mjs: 'javascript',
  php: 'php',
  pl: 'perl',
  ps1: 'powershell',
  py: 'python',
  r: 'r',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  sql: 'sql',
  swift: 'swift',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  vue: 'vue',
  xml: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  zsh: 'bash',
}

export function langOf(path: string): string {
  const dot = path.lastIndexOf('.')

  if (dot === -1) {
    return ''
  }

  const cut = path.indexOf(':', dot)
  const extension = (cut === -1 ? path.slice(dot + 1) : path.slice(dot + 1, cut)).toLowerCase()

  return LANGS[extension] ?? ''
}

/** 产出 details：`{ content, details }` 里那一格；老会话的纯文本产出没有 details。 */
export function outputDetails(output: OmpToolOutputOf | undefined): OmpToolDetailsOf {
  return typeof output === 'string' ? undefined : output?.details
}

/** 产出正文块。 */
export function outputBlocks(output: OmpToolOutputOf | undefined): readonly OmpToolContentBlock[] {
  return typeof output === 'string' ? NONE : (output?.content ?? NONE)
}

export function outputText(output: OmpToolOutputOf | undefined): string | undefined {
  if (typeof output === 'string') {
    return output === '' ? undefined : output
  }

  const parts: string[] = []
  for (const block of outputBlocks(output)) {
    if (block.type === 'text' && block.text !== undefined) {
      parts.push(block.text)
    }
  }

  const joined = parts.join('\n')

  return joined === '' ? undefined : joined
}

export function outputImages(output: OmpToolOutputOf | undefined): readonly ToolCallContent[] {
  const images: ToolCallContent[] = []
  for (const block of outputBlocks(output)) {
    if (block.type === 'image' && block.data !== undefined) {
      images.push({
        type: 'content',
        content: { type: 'image', data: block.data, mimeType: block.mimeType ?? 'image/png' },
      })
    }
  }

  return images
}

/**
 * 处理器看到的那一格：入参与 details 按工具名精确，二者都可能还没到（调用刚发出、结果没回来）。
 * 老会话与流式覆盖里的产出是纯文本，`OmpToolOutputOf` 里已经包含那一档。
 */
export interface Ctx<N extends OmpToolName = OmpToolName> {
  readonly input: OmpToolInput<N> | undefined
  readonly details: OmpToolDetails<N> | undefined
  readonly output: OmpToolOutput<N>
  readonly said: string | undefined
  readonly error: string | undefined
}

export type Handler<N extends OmpToolName = OmpToolName> = (ctx: Ctx<N>) => OmpToolView

export const failed = (ctx: Ctx<OmpToolName>): boolean => ctx.error !== undefined && ctx.error !== ''
export const saidText = (ctx: Ctx<OmpToolName>): readonly ToolCallContent[] =>
  ctx.said === undefined ? NONE : [text(ctx.said)]
export const proseSaid = (ctx: Ctx<OmpToolName>): readonly ToolCallContent[] =>
  ctx.said === undefined ? NONE : [prose(ctx.said)]
export const failOr = (ctx: Ctx<OmpToolName>, body: readonly ToolCallContent[]): readonly ToolCallContent[] =>
  failed(ctx) ? [text(ctx.error ?? '这次调用失败了。')] : body

// invokedTool 由出口填：处理器只管自己这一格，认名字那一步在 ompToolView 里做一次。
export function view(
  kind: ToolKind,
  headline: string,
  subject: string,
  request: readonly ToolCallContent[],
  response: readonly ToolCallContent[],
  shape: ToolDrawerShape = 'flow',
): OmpToolView {
  return {
    known: true,
    kind,
    invokedTool: '',
    scheme: '',
    headline,
    subject,
    shape,
    background: false,
    request,
    response,
  }
}
