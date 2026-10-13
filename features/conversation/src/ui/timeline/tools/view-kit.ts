import { invariant } from '@poietica/foundation'
import type { ToolCallContent, ToolDrawerShape, ToolKind } from '../../agent/tool-call'

// omp 工具调用的因地制宜视图：按工具名查标准答案，认不出的交回空视图由调用方兜底。
// 产出优先于入参（edit/read 的真实内容在产出 details 里）；图片在出口统一追加。

export type { ToolDrawerShape }

export interface OmpToolView {
  readonly known: boolean
  readonly kind: ToolKind
  /*
   * 真正在跑的那个工具的名字。
   *
   * 平时就是帧上的 name；只有 `write xd://<工具>` 例外 —— 帧上是 write，跑的是被挂载
   * 的那个设备。字形按名字取，认 write 会画成铅笔而屏幕上写着「读取诊断」。
   */
  readonly invokedTool: string
  /**
   * 这次碰的是什么地址的内部资源（`skill` / `memory` / `xd` …），空串表示不是内部资源。
   *
   * 取 omp 自己盖的章 details.meta.source（OutputMetaBuilder 的 sourceInternal），
   * 跑的时候还没有产出，退回入参 path 的 scheme。
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
 * 出口反向登记：writeView 遇到 xd:// 设备委派时要用整张 HANDLERS 表再认一次名字，
 * 而表在 registry.ts 里、registry 又 import 每个视图文件 —— 直接互相 import 就成环。
 * 出口在模块求值完之后把 ompToolView 挂上来，视图文件只经这一格回调。
 */
export type ViewLookup = (tool: string, input: unknown, output: unknown) => OmpToolView

let lookupView: ViewLookup | undefined

export function registerViewLookup(lookup: ViewLookup): void {
  lookupView = lookup
}

export function viewOf(tool: string, input: unknown, output: unknown): OmpToolView {
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

export function bag(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

// 唯一读 unknown 对象的地方：noPropertyAccessFromIndexSignature 下 bag(x).y 不合法。
export const get = (value: unknown, key: string): unknown => bag(value)?.[key]

export const pick = (input: unknown, key: string): string | undefined => {
  const value = get(input, key)

  return typeof value === 'string' && value !== '' ? value : undefined
}

export const numb = (input: unknown, key: string): number | undefined => {
  const value = get(input, key)

  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export const flag = (input: unknown, key: string): boolean => get(input, key) === true

export const list = (input: unknown, key: string): readonly unknown[] => {
  const value = get(input, key)

  return Array.isArray(value) ? value : NONE
}

export const NO_STRINGS: readonly string[] = []

export function strings(input: unknown, key: string): readonly string[] {
  const value = get(input, key)

  if (typeof value === 'string') {
    return value === '' ? NO_STRINGS : [value]
  }

  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one !== '') : NO_STRINGS
}

export type Block = {
  readonly type: string
  readonly text?: string
  readonly data?: string
  readonly mimeType?: string
}

export function blocksOf(output: unknown): readonly Block[] {
  const held = get(output, 'content')

  return Array.isArray(held) ? (held as readonly Block[]) : NONE
}

export function textOf(output: unknown): string | undefined {
  if (typeof output === 'string') {
    return output === '' ? undefined : output
  }

  const joined = blocksOf(output)
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('\n')

  return joined === '' ? undefined : joined
}

export function imagesOf(output: unknown): readonly ToolCallContent[] {
  return blocksOf(output)
    .filter((block) => block.type === 'image' && typeof block.data === 'string')
    .map((block) => ({
      type: 'content' as const,
      content: {
        type: 'image' as const,
        data: block.data as string,
        mimeType: block.mimeType ?? 'image/png',
      },
    }))
}

export const detailsOf = (output: unknown): unknown => get(output, 'details')

export interface Ctx {
  readonly input: unknown
  readonly details: unknown
  readonly said: string | undefined
  // xd:// 设备委派要拿它的 content 块当被调工具的产出。
  readonly output: unknown
  readonly error: string | undefined
}

export type Handler = (ctx: Ctx) => OmpToolView

export const failed = (ctx: Ctx): boolean => ctx.error !== undefined && ctx.error !== ''
export const saidText = (ctx: Ctx): readonly ToolCallContent[] => (ctx.said === undefined ? NONE : [text(ctx.said)])
export const proseSaid = (ctx: Ctx): readonly ToolCallContent[] => (ctx.said === undefined ? NONE : [prose(ctx.said)])
// 失败时那一句顶替产出。
export const failOr = (ctx: Ctx, body: readonly ToolCallContent[]): readonly ToolCallContent[] =>
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
