import type { ToolCallContent } from '@poietica/agent-contract'

import { type DiffStat, type ToolContentPart, toToolCallView } from './tool-call-content'

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
 * 这一层不认识 React，也不认识时间线的条目类型：入参按形状收，与 tool-call-content
 * 只依赖 @poietica/agent-contract 是同一条边界。
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
  readonly diffStat: DiffStat | null
  /** 送出去的那一面，一段 markdown；上游没送入参就是 null。 */
  readonly request: string | null
  /** 交回来的那一面，一段 markdown；什么都还没有就是 null。 */
  readonly response: string | null
}

/*
 * 一次调用能有多大：edit 与 write 类工具的入参里装着整份文件正文，抓页面的产出装着
 * 一整篇 DOM 文本。Shiki 的分词是线性的，但常数不小。64 KiB 之后按行截断。
 *
 * 这个上限与虚拟化不是一件事，两个都要：虚拟化省的是「这一帧要画多少」，它省的是
 * 「这段文本值不值得留在内存里被切成块」。
 */
const CAP = 64 * 1024

/** 缩进两格 —— JSON.stringify 的 space 参数，也是这个格式的通行排版。 */
const INDENT = 2

/*
 * 路径印成正斜杠。
 *
 * JSON 的字符串里反斜杠必须成对（RFC 8259 §7），所以一条 Windows 路径落进这一格天然是
 * C:\\Users\\…：屏幕上那对反斜杠是转义留下的，不是路径本身。Win32 的文件 API 与 Node
 * 的 path 都把正斜杠当合法分隔符，所以换成 / 之后这条路径复制出去照样能用。
 *
 * 只认盘符开头的绝对路径与 UNC 前缀。别的字符串一律不动 —— 正则、代码正文、转义序列里
 * 的反斜杠都带语义，替换它们是在改数据，不是改排版。
 */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/])/

function toDisplayPath(text: string): string {
  return WINDOWS_PATH.test(text) ? text.replaceAll('\\', '/') : text
}

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

function clamp(text: string): string {
  if (text.length <= CAP) {
    return text
  }

  const cut = text.lastIndexOf('\n', CAP)

  return `${text.slice(0, cut > 0 ? cut : CAP)}\n…（内容过长，上面只是开头）`
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
  const text = clamp(body)
  const rail = railFor(text, 3)

  return `${rail}${lang}\n${text}\n${rail}`
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

/*
 * 这里此前还在上面单印一行受影响的路径。不印了：入参自己的 path 字段说的是同一件事，
 * 标题栏也有同一份，三处说同一件事只留一处。
 */
/**
 * 送出去的那一面。
 *
 * display 映出来的那几块优先：一条命令、一份清单、一段计划、一次写入的 diff 都是
 * 我们送出去的东西，它们比一份原始入参更接近人要看的那件事。缺席才退回入参。
 */
function requestOf(source: ToolCallFacetSource, parts: readonly ToolContentPart[]): string | null {
  if (parts.length > 0) {
    return parts.map((part) => partMarkdown(part)).join('\n\n')
  }

  return bagOf(source.rawInput)
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

function mark(text: string, sign: string): string {
  return text
    .split('\n')
    .map((line) => `${sign}${line}`)
    .join('\n')
}

/**
 * 一处改动，写成统一 diff。
 *
 * Shiki 的 diff 语法认的就是行首这两个符号 —— GitHub、VS Code、Zed 画 diff 用的都是
 * 它。而且这张样式表早已为它付过款：timeline.css 里 pre code span 那条写着
 * background-color: var(--sdm-tbg, transparent)，注释逐字说「少数 token 自带底色
 *（diff、命中标记）」。能力一直通着，此前旁边却另画了一套红绿。
 */
function diffBody(oldText: string | null, newText: string): string {
  const added = mark(newText, '+')

  return oldText === null ? added : `${mark(oldText, '-')}\n${added}`
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

function partMarkdown(part: ToolContentPart): string {
  if (part.type === 'text') {
    return textBlock(part.text)
  }

  if (part.type === 'command') {
    return block(part.language, part.command)
  }

  if (part.type === 'prose') {
    /* 计划正文本来就是 markdown：包进围栏会把标题与列表连符号一起印出来。 */
    return clamp(part.text)
  }

  if (part.type === 'todo') {
    return todoList(part.items)
  }

  if (part.type === 'diff') {
    const body = block('diff', diffBody(part.oldText, part.newText))

    return `${inlineCode(toDisplayPath(part.path))}\n\n${body}`
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

/** 协议只给了 rawOutput 的时候，它就是这一面唯一交得出来的东西。 */
function outputOf(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null
  }

  if (typeof value === 'string') {
    return value === '' ? null : textBlock(value)
  }

  return jsonBlock(value)
}

function responseOf(source: ToolCallFacetSource, parts: readonly ToolContentPart[]): string | null {
  const pieces: string[] = parts.map((part) => partMarkdown(part))

  if (pieces.length === 0) {
    const output = outputOf(source.rawOutput)

    if (output !== null) {
      pieces.push(output)
    }
  }

  return pieces.length === 0 ? null : pieces.join('\n\n')
}

/**
 * 两个面，一趟算完。渲染器只读不算。
 *
 * 交出去的是字符串而不是一份对象树，所以这一层不需要一张 WeakMap：同样内容的字符串
 * 逐字相等，下游那几个 useMemo 的依赖比较照样命中。
 */
/**
 * 这次调用一共改了多少行。
 *
 * 一次写入的 diff 挂在送出去那一面，一份产出的 diff 挂在交回来那一面，而标题栏那个
 * 徽章问的是整次调用 —— 所以两面都算。
 */
function mergeDiff(sent: DiffStat | null, back: DiffStat | null): DiffStat | null {
  if (sent === null) {
    return back
  }

  if (back === null) {
    return sent
  }

  return { added: sent.added + back.added, removed: sent.removed + back.removed }
}

export function toToolCallFacets(source: ToolCallFacetSource): ToolCallFacets {
  const sent = toToolCallView(source.requestContent)
  const back = toToolCallView(source.content)

  return {
    diffStat: mergeDiff(sent.diffStat, back.diffStat),
    request: requestOf(source, sent.parts),
    response: responseOf(source, back.parts),
  }
}
