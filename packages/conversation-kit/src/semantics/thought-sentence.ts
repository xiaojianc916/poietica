/*
 * 身份用这句话在原文里的起始偏移：原文只往后长，偏移因此稳定 —— 同一句继续写 key 不变，出现下一句才换 key（上下刷一次）。
 * 用行号做身份，一整段不换行的思考就只看得到横移（T-04）。Markdown 记号只在这一层的显示文本上抹掉；偏移与 key 一律用原文算。
 */

export interface ThoughtSentence {
  readonly key: string
  readonly text: string
}

export interface ThoughtSentences {
  readonly current: ThoughtSentence
  /** 同一批 token 里旧句收尾、新句开头时，容器用它把旧句补完。 */
  readonly previous: ThoughtSentence | null
}

/** 没有标点的超长段落按此切成「软句」，否则一句无限长。 */
export const MAX_SENTENCE_CHARS = 400

/** 软句退而求其次的切点区间下限：优先断在标点或空白上，断不了才硬切。 */
const SOFT_MIN_CHARS = 320

/** 往回找句界最多扫这么多字符；超出按绝对落点对齐切。 */
export const BACKSCAN_LIMIT = 4000

/** 往回退的上限：正常一两步就够，余下的给「整段都在代码块里」两处极端。 */
const MAX_HOPS = 16

const EMPTY: ThoughtSentence = { key: '', text: '' }

/** 句末标点后面的收尾符号，归前一句。 */
const CLOSERS = new Set(['”', '’', '」', '』', '）', ')', '】', '》', ']', '"', "'"])

const SOFT_BREAKS = new Set(['，', '、', ',', ';', '；', '：', ':'])

/** 缩写后的 `.` 不算句界：漏判只是没断句，误判是把一句劈成两句，所以这张表宁多勿少。 */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'etc', 'vs', 'mr', 'mrs', 'ms', 'dr', 'no', 'fig', 'cf', 'al'])

const FENCE = /^(?:`{3,}|~{3,})/u
const LINE_MARKER = /^(?:#{1,6}\s+|[-*+•]\s+|\d+[.)]\s+|>\s?)/u
const IMAGE = /!\[([^\]]*)\]\([^)]*\)/gu
const LINK = /\[([^\]]*)\]\([^)]*\)/gu
const STRONG = /\*\*([\s\S]+?)\*\*/gu
const EMPHASIS = /__([\s\S]+?)__/gu
const CODE = /`+([^`]+)`+/gu
/** 还没闭合的链接起点：流式里 `[链接` 与 `](url)` 分两批到，前一批不该印出那个方括号。 */
const DANGLING_BRACKET = /\[(?![^\]]*\])/gu

/** 围栏开合到第几次：奇数就是落在一段代码块里面。 */
function insideFence(text: string, at: number): boolean {
  let open = false
  let from = 0

  for (;;) {
    const end = text.indexOf('\n', from)
    const complete = end >= 0 && end < at
    const line = text.slice(from, complete ? end : at)

    if (FENCE.test(line.trimStart())) open = !open

    if (!complete) return open

    from = end + 1
  }
}

const isSpace = (ch: string | undefined): boolean => ch !== undefined && /\s/u.test(ch)

/** 到末尾就 null（句界之后还没有下一句）。 */
function skipSpace(text: string, from: number): number | null {
  for (let at = from; at < text.length; at += 1) {
    if (!isSpace(text[at])) return at
  }

  return null
}

/** 吞掉紧随句末标点的收尾符号：`他说：“好。”然后` 里那句号属于前一句。 */
function swallowClosers(text: string, from: number): number {
  let at = from

  while (at < text.length && CLOSERS.has(text[at] ?? '')) {
    at += 1
  }

  return at
}

/**
 * 英文那套：收尾符号之后**必须**跟空白才算句界。`file.ts`、`v1.2`、`3.14` 后面跟的是字母数字，于是天然不是句界。
 */
function spacedStart(text: string, at: number): number | null {
  const after = swallowClosers(text, at + 1)

  return isSpace(text[after]) ? skipSpace(text, after) : null
}

function wordBefore(text: string, at: number): string {
  let from = at

  while (from > 0 && /[A-Za-z.]/u.test(text[from - 1] ?? '')) {
    from -= 1
  }

  return text.slice(from, at)
}

/** 省略号、缩写、姓名缩写都不算句界。 */
function isPeriodBoundary(text: string, at: number): boolean {
  if (text[at - 1] === '.') return false

  const word = wordBefore(text, at)

  if (ABBREVIATIONS.has(word.toLowerCase())) return false

  /* 单个大写字母是姓名缩写（`J. Smith`），跟着一个词走。 */
  return !(word.length === 1 && /[A-Z]/u.test(word))
}

/**
 * 位置 `at` 是句界就交出下一句的起点，不是就 null。中文的 `。！？` 不要求后续有空白（中文本来就不写空格），
 * 英文的 `!?` 与 `.` 必须跟空白 —— 判据不是「像不像句尾」，而是「下一句是不是真的开始了」。
 */
function boundaryAfter(text: string, at: number): number | null {
  const ch = text[at]

  if (ch === '\n') return skipSpace(text, at + 1)
  if (ch === '。' || ch === '！' || ch === '？') return skipSpace(text, swallowClosers(text, at + 1))
  if (ch === '!' || ch === '?') return spacedStart(text, at)
  if (ch === '.' && isPeriodBoundary(text, at)) return spacedStart(text, at)

  return null
}

/** 硬切点不能落在 UTF-16 代理对中间，否则会切出半个字。 */
function surrogateSafe(text: string, at: number): number {
  const code = text.charCodeAt(at - 1)
  const highSurrogate = code >= 0xd800 && code <= 0xdbff

  return highSurrogate ? at + 1 : at
}

/**
 * 只读 start 之后的文本，已经定下的切点因此不会随新字移动，软句的 key 也就跟着稳定。
 */
function softCut(text: string, start: number): number {
  const limit = Math.min(start + MAX_SENTENCE_CHARS, text.length)
  const from = start + SOFT_MIN_CHARS

  if (from < limit) {
    const window = text.slice(from, limit)

    for (let at = window.length - 1; at >= 0; at -= 1) {
      const ch = window[at] ?? ''

      if (isSpace(ch) || SOFT_BREAKS.has(ch)) {
        /* 断在它「之后」：标点归前一句。 */
        const cut = from + at + 1
        const next = skipSpace(text, cut)

        return next === null ? limit : next
      }
    }
  }

  return surrogateSafe(text, limit)
}

/** 把 hard 到 end 之间的超长段落按软句推进，取最后一段的起点。 */
function softStart(text: string, hard: number, end: number): number {
  let start = hard

  while (end - start > MAX_SENTENCE_CHARS) {
    const cut = softCut(text, start)

    if (cut <= start || cut >= end) return start

    start = cut
  }

  return start
}

/**
 * 句界可能远在 BACKSCAN_LIMIT 之外（模型贴几千行代码块时），那时用只跟长度有关的绝对落点兜底，同样稳定。
 */
function lastSentenceStart(text: string, end: number): number {
  const floor = Math.max(0, end - BACKSCAN_LIMIT)
  let hard = -1

  for (let at = end - 1; at >= floor; at -= 1) {
    const start = boundaryAfter(text, at)

    if (start !== null && start < end) {
      hard = start
      break
    }
  }

  if (hard < 0) {
    /* 扫到头就从 0 起；取 end - 1 再对齐 —— end 恰是 400 的整数倍时，按 end 对齐会得到 end 自己。 */
    hard = floor === 0 ? 0 : Math.floor((end - 1) / MAX_SENTENCE_CHARS) * MAX_SENTENCE_CHARS
  }

  return softStart(text, hard, end)
}

interface Step {
  readonly key: string
  readonly text: string
  readonly start: number
}

/**
 * 要退过去两种东西：去记号后为空的句子、整句落在一段代码块里面的句子 —— 模型写代码块期间组头该停在前面最后一句人话上，
 * 而不是把 `const a = 1` 当成思考念出来（MAX_HOPS 兜住「整段都在代码块里」那种探不到头的写法）。
 */
function walkBack(text: string, cursor: number): Step | null {
  let at = cursor

  for (let hops = 0; hops < MAX_HOPS; hops += 1) {
    const start = lastSentenceStart(text, at)

    if (start >= at) return null

    const said = stripThoughtMarkup(text.slice(start, at))

    if (said !== '' && !insideFence(text, start)) return { key: String(start), text: said, start }

    at = start

    if (at === 0) return null
  }

  return null
}

/** 单个 `*`、`_` 不处理：`a_b`、`2*3` 这类误伤的代价比漏一个记号大得多。 */
export function stripThoughtMarkup(sentence: string): string {
  const text = sentence.trim()

  /* 整句就是一行围栏（```ts / ~~~）：它不是话，是代码块的边。 */
  if (FENCE.test(text)) return ''

  return text
    .replace(LINE_MARKER, '')
    .replace(IMAGE, '$1')
    .replace(LINK, '$1')
    .replace(STRONG, '$1')
    .replace(EMPHASIS, '$1')
    .replace(CODE, '$1')
    .replace(DANGLING_BRACKET, '')
    .trim()
}

export function readThoughtSentence(raw: string): ThoughtSentences {
  const text = raw.replaceAll(/\r\n?/gu, '\n')

  if (text.trim() === '') return { current: EMPTY, previous: null }

  const head = walkBack(text, text.length)

  /* 通篇都是围栏或空行，没有可印的人话：身份交空串，占位那一格会兜住。 */
  if (head === null) return { current: EMPTY, previous: null }

  const before = walkBack(text, head.start)

  return {
    current: { key: head.key, text: head.text },
    previous: before === null ? null : { key: before.key, text: before.text },
  }
}
