import { type DiffFile, type DiffStat, diffStatOf } from '@poietica/review'
import type { ToolCallContent } from '../../agent/tool-call'

import { toDiffFiles, toDisplayPath } from './file-diff'
import { type ToolContentPart, toToolContentParts } from './tool-call-content'

/**
 * 一次工具调用的两个面：送出去的那一份，和交回来的那一份。
 *
 * 两个面交出去的都是 markdown，因为渲染它们的只有一条管线 —— 带语言标注的围栏交给
 * Streamdown，Shiki 上色，围栏的外壳（语言胶囊、复制按钮、内框）由样式在抽屉作用域
 * 里摘掉。这一层只负责说清楚「这一段是什么」。
 *
 * ## 送出去的那一面按 display 画，入参是兜底
 *
 * kap 为每次调用带一份显示提示（ToolInputDisplay，十三档），投影层已经把它映成了
 * requestContent —— 一条命令是一块带语言标注的围栏，一份清单是一张勾选表，一份计划
 * 就是它自己的 markdown。上游自己的客户端也是这么画的（apps/vscode 的
 * toLegacyDisplay），一次都不读原始入参。display 缺席时才退回入参那份 JSON 文档。
 *
 * ## 兜底的入参与产出都是 JSON，都重排过
 *
 * 入参是一份 JSON 文档，屏幕上就画一份 JSON 文档 —— JSON.stringify(value, null, 2)。
 * 缩进两格、每一层一对大括号、数组一行一个元素。这是 DevTools 的 Payload 面板按下
 * Pretty print、Postman 的 Pretty、GitHub 渲染一个 .json 文件时给的同一种排版，也是
 * 这个格式唯一被普遍接受的那一种。
 *
 * 产出走同一条判据：解析得动就按同样的两格重排，解析不动就原样。重排动的只有空白 ——
 * JSON 的空白不承载语义（RFC 8259 §2），所以这不改数据，只改可读性。
 *
 * ## 不截断
 *
 * 这里此前按 64 KiB 截断长产出，截完补一句「内容过长」。那个上限和它想解决的事错配
 * 了：它省的是「这一帧画多少」，赔进去的是字符本身。量改由抽屉自己接 —— 超过阈值的
 * 产出按行虚拟化，见 tool-output-lines.tsx。
 *
 * 这一层不认识 React，也不认识时间线的条目类型：入参按形状收，与 tool-call-content
 * 只依赖 @poietica/conversation 是同一条边界。
 */

/** 画这两个面需要的全部原料；ToolCallTimelineItem 天然满足它。 */
export interface ToolCallFacetSource {
  /** 送出去的那一份，由 kap 的 display 映来。 */
  readonly requestContent?: readonly ToolCallContent[] | undefined
  /** 交回来的那一份：进度与产出。 */
  readonly content: readonly ToolCallContent[]
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
}

export interface ToolCallFacets {
  /** 这次调用改动的每一处文件；空表示这不是一次改动。 */
  readonly diffs: readonly DiffFile[]
  readonly diffStat: DiffStat | null
  /** 送出去的那一面，一段 markdown；上游没送入参就是 null。 */
  readonly request: string | null
  /** 交回来的那一面，一段 markdown；什么都还没有就是 null。 */
  readonly response: string | null
}

/** 缩进两格 —— JSON.stringify 的 space 参数，也是这个格式的通行排版。 */
const INDENT = 2

/**
 * 一个字符串在屏幕上印成什么。
 *
 * 装着一份 JSON 文档的字符串就摊开成那份文档。它在协议里确实是字符串，但在人眼里是一份
 * 文档：包在外层 JSON 里再序列化一次，每一个引号都要转义，整份内容被压成一行 —— 屏幕上
 * 那一串反斜杠是转义留下的，不是内容本身。抽屉里的围栏是给人看的（外壳与复制按钮由
 * timeline.css 在这个作用域里摘掉），所以这一面选可读，不选可再解析。
 *
 * 摊开这一步不必递归：stringify 会继续遍历 replacer 交回的值，嵌套几层就走几层。
 *
 * 不是文档才问它是不是路径。两条判据的顺序不能反 —— 一份 JSON 文档里的反斜杠归它自己。
 */
function display(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw
  }

  return readJsonDocument(raw) ?? toDisplayPath(raw)
}

/** 这个文件里唯一一处把值印成 JSON 源码的地方；两个面共用同一套显示判据。 */
function displayJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key: string, raw: unknown) => display(raw), INDENT)
}

/**
 * 围栏得比正文里最长的那串反引号还长一格。
 *
 * 固定写三个是一个真实的缺口：工具输出里出现三连反引号一点都不罕见（读一份 markdown、
 * 抓一个页面、让子代理写文档），而 CommonMark 规定闭合围栏不短于开启围栏 —— 正文里
 * 那一行会把围栏提前收口，后面半段掉出去当散文渲染。
 */
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

/** 一块带语言标注的围栏。info string 是 CommonMark 的官方语法，Shiki 认的就是它。 */
function block(lang: string, body: string): string {
  const rail = railFor(body, 3)

  return `${rail}${lang}\n${body}\n${rail}`
}

/**
 * 一块围栏里的那些行；这份 markdown 不是「一整块围栏」就交回 null。
 *
 * block() 的逆运算，与它同住一个文件 —— 围栏长什么形状只有这一处知道。抽屉里那份
 * 输出超过阈值时按行虚拟化（tool-output-lines.tsx），要的就是这些行；交回 null 表示
 * 这一面不是一段机器输出（计划正文、勾选表、多段拼接都在此列），那时按 markdown 画。
 */
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

/**
 * 一个值印在行里。
 *
 * 走行内代码而不是裸文本，是为了让反斜杠原样留下：markdown 的正文会把它当转义前缀
 * 吃掉，一个 Windows 路径印出来就少一半分隔符。行内代码里不发生任何转义。
 */
function inlineCode(value: string): string {
  if (value === '') {
    return '`""`'
  }

  const rail = railFor(value, 1)
  const pad = value.startsWith('`') || value.endsWith('`') || value.trim() !== value ? ' ' : ''

  return `${rail}${pad}${value}${pad}${rail}`
}

/**
 * 一段字节是不是一份 JSON 文档。全文件唯一的一处判据 —— 最外层那一整串产出问的是它，
 * 嵌在字段里的那一份问的也是它，所以同一份字节不会因为藏得深就换一种画法。
 *
 * 判据与 DevTools 在没有 content-type 时用的一样：形状对得上，而且真的解析得动 ——
 * 只看 JSON.parse 会把一行 123 的日志也认成 JSON。只认对象与数组：一个裸标量重排前后
 * 一模一样，白跑一趟。
 */
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

/** 一份 JSON 文档按两格重排；不是文档就交回 null，由调用方决定按什么上色。 */
function prettyJson(text: string): string | null {
  const parsed = readJsonDocument(text)

  return parsed === null ? null : (displayJson(parsed) ?? null)
}

/** 一份值印成一块 JSON 围栏。 */
function jsonBlock(value: unknown): string | null {
  try {
    /* stringify 对 undefined / 函数 / symbol 交回 undefined，声明里没写这一半。 */
    const text: string | undefined = displayJson(value)

    return text === undefined ? null : block('json', text)
  } catch {
    /* 循环引用：这一面交不出来，但不能让整张卡片跟着塌。 */
    return null
  }
}

/* ── 送出去的那一面 ───────────────────────────────────────── */

/* 空信封不算一面：无参工具的入参常常就是一个 {}，为它开一个页签只会给出两个大括号。 */
function isEmptyBag(value: object): boolean {
  return Array.isArray(value) ? value.length === 0 : Reflect.ownKeys(value).length === 0
}

/** 上游没给显示提示时，这一面唯一交得出来的东西。 */
function bagOf(bag: unknown): string | null {
  if (bag === undefined || bag === null) {
    return null
  }

  if (typeof bag === 'object' && isEmptyBag(bag)) {
    return null
  }

  return jsonBlock(bag)
}

/* ── 交回来的那一面 ───────────────────────────────────────── */

/** 一段产出：是 JSON 文档就重排并按 json 上色，否则原样按纯文本。 */
function textBlock(text: string): string {
  const pretty = prettyJson(text)

  return pretty === null ? block('text', text) : block('json', pretty)
}

/**
 * 一张勾选表。
 *
 * GFM 的 task list 只有两格，而状态有三档 —— 进行中那一档在标题后面点出来，少这
 * 一句就把它读成了待办。
 */
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
    /* 计划正文本来就是 markdown：包进围栏会把标题与列表连符号一起印出来。 */
    return part.text
  }

  if (part.type === 'todo') {
    return todoList(part.items)
  }

  if (part.type === 'terminal') {
    return `终端 ${inlineCode(part.terminalId)}`
  }

  if (part.type === 'link') {
    /* 行内代码而不是 markdown 链接：抽屉里这一面是给人读和复制的，一个点不开的
       锚点不如一串看得清的地址。 */
    const uri = inlineCode(part.uri)

    return part.name === null ? uri : `${part.name} ${uri}`
  }

  return part.label
}

/*
 * 协议只给了 rawOutput 的时候，它就是这一面唯一交得出来的东西。
 * omp 的产出信封（AgentToolResult：content 块数组）在这里拆开：文本块接起来画，
 * 图块折成 markdown 图；空信封不画 —— 一对空括号不是产出。
 */
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
        pieces.push(`![截图](data:${block.mimeType ?? 'image/png'};base64,${block.data})`)
      }
    }

    return pieces.length === 0 ? null : pieces.join('\n\n')
  }

  return jsonBlock(value)
}

/** 一面里画得出来的那些片段接成一段 markdown；一段都没有就是 null。 */
function proseOf(parts: readonly ToolContentPart[]): string | null {
  const pieces: string[] = []

  for (const part of parts) {
    if (part.type !== 'diff') {
      pieces.push(partMarkdown(part))
    }
  }

  return pieces.length === 0 ? null : pieces.join('\n\n')
}

/** 这次调用改动的每一处；两面各按片段数组记过账，所以这条路可以在渲染里反复走。 */
export function toDiffFilesOf(source: ToolCallFacetSource): readonly DiffFile[] {
  const sent = toDiffFiles(toToolContentParts(source.requestContent))
  const back = toDiffFiles(toToolContentParts(source.content))

  if (sent.length === 0) {
    return back
  }

  return back.length === 0 ? sent : [...sent, ...back]
}

/**
 * 三格，一趟算完，渲染器只读不算。
 *
 * 改动不再走 markdown：围栏里没有行号的位置，带行号的统一 diff 才是它的画法
 * （file-diff.ts）。标题栏那个徽章也从同一批行上数出来，屏幕与账目不会各说一套。
 */
export function toToolCallFacets(source: ToolCallFacetSource): ToolCallFacets {
  const sent = toToolContentParts(source.requestContent)
  const back = toToolContentParts(source.content)
  const diffs = toDiffFilesOf(source)

  return {
    diffs,
    diffStat: diffStatOf(diffs),
    request: sent.length === 0 ? bagOf(source.rawInput) : proseOf(sent),
    response: back.length === 0 ? outputOf(source.rawOutput) : proseOf(back),
  }
}
