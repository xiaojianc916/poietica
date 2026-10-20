/* 浏览器卡片的数据层：只认 omp 18.5 的 eval 形状（浏览器是 eval 的 prelude，不是顶层工具）。一次
 * browser.open(...) 经 describeBrowserCall 把 { op: 'browser', detail: 'open main https://…' } 写进
 * details.statusEvents 与 details.cells[].statusEvents，截图落在 details.images[]；入参只有
 * { language, code, title } —— 按旧顶层工具的 args.action / args.url 读，读到的永远是空的。 */

export interface BrowserStep {
  readonly action: string // open / close / goto / click / run / tabs …
  readonly tab: string | null // 标签名（main…）；tabs / close all 没有
  readonly target: string | null // url、选择器或调用链的剩余部分
  readonly said: string // 原样的 detail，给人看
}

export interface BrowserCallModel {
  readonly steps: readonly BrowserStep[]
  readonly code: string | null
  readonly language: 'js' | 'py'
  readonly text: string // 输出正文，最多 4000 字
  readonly images: readonly { readonly src: string; readonly alt: string }[]
  readonly error: string | null
}

const TEXT_CAP = 4000
const IMAGE_ALT = '浏览器截图'
const DEFAULT_MIME = 'image/png'

function bag(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

function pick(value: unknown, key: string): string | null {
  const raw = bag(value)[key]

  return typeof raw === 'string' ? raw : null
}

function list(value: unknown, key: string): readonly unknown[] {
  const raw = bag(value)[key]

  return Array.isArray(raw) ? raw : []
}

function statusEventsOf(details: unknown): readonly unknown[] {
  const events = [...list(details, 'statusEvents')]

  for (const cell of list(details, 'cells')) {
    events.push(...list(cell, 'statusEvents'))
  }

  return events
}

function stepsOf(details: unknown): readonly BrowserStep[] {
  const steps: BrowserStep[] = []
  const seen = new Set<string>()

  for (const event of statusEventsOf(details)) {
    if (pick(event, 'op') !== 'browser') {
      continue
    }

    const detail = pick(event, 'detail')

    if (detail === null || detail === '' || seen.has(detail)) {
      continue
    }

    seen.add(detail)
    steps.push(parseStep(detail))
  }

  return steps
}

function parenBody(detail: string): string | null {
  const open = detail.indexOf('(')

  if (open === -1) {
    return null
  }

  let depth = 0

  for (let at = open; at < detail.length; at += 1) {
    const char = detail[at]

    if (char === '(') {
      depth += 1
    } else if (char === ')') {
      depth -= 1

      if (depth === 0) {
        return detail.slice(open + 1, at)
      }
    }
  }

  return null
}

function unquote(text: string): string {
  const trimmed = text.trim()
  const first = trimmed.at(0)
  const last = trimmed.at(-1)

  return trimmed.length >= 2 && (first === '"' || first === "'" || first === '`') && last === first
    ? trimmed.slice(1, -1)
    : trimmed
}

type Scan = { readonly quote: string | null; readonly depth: number; readonly stop: boolean }

function step(char: string, at: Scan): Scan {
  if (at.quote !== null) {
    return { quote: char === at.quote ? null : at.quote, depth: at.depth, stop: false }
  }

  if (char === '"' || char === "'" || char === '`') {
    return { quote: char, depth: at.depth, stop: false }
  }

  if (char === '(' || char === '[' || char === '{') {
    return { quote: null, depth: at.depth + 1, stop: false }
  }

  if (char === ')' || char === ']' || char === '}') {
    return { quote: null, depth: at.depth - 1, stop: false }
  }

  return { quote: null, depth: at.depth, stop: char === ',' && at.depth === 0 }
}

function firstArgument(body: string): string | null {
  let at: Scan = { quote: null, depth: 0, stop: false }

  for (let index = 0; index < body.length; index += 1) {
    at = step(body[index] ?? '', at)

    if (at.stop) {
      return unquote(body.slice(0, index))
    }
  }

  const only = unquote(body)

  return only === '' ? null : only
}

function callStep(detail: string, said: string): BrowserStep {
  const called = /^([^\s.()]+)\.([A-Za-z_$][\w$]*)(?=[.(])/u.exec(detail)

  if (called === null) {
    return { action: '', tab: null, target: null, said }
  }

  const inside = parenBody(detail)

  return {
    action: called[2] ?? '',
    tab: called[1] ?? null,
    target: inside === null ? null : firstArgument(inside),
    said,
  }
}

/** 每档都留着上游原话，认不出时也不是一片空白。 */
export function parseStep(detail: string): BrowserStep {
  const said = detail

  if (detail === 'tabs') {
    return { action: 'tabs', tab: null, target: null, said }
  }

  if (detail === 'close all') {
    return { action: 'close', tab: null, target: 'all', said }
  }

  const opened = /^open\s+(\S+)(?:\s+(\S+))?$/u.exec(detail)

  if (opened !== null) {
    return { action: 'open', tab: opened[1] ?? null, target: opened[2] ?? null, said }
  }

  const closed = /^close\s+(\S+)$/u.exec(detail)

  if (closed !== null) {
    return { action: 'close', tab: closed[1] ?? null, target: null, said }
  }

  return callStep(detail, said)
}

/** 真正跑过的代码在产出里（一个 eval 可以带多个 cell）；还没有产出时才照入参画。 */
function codeOf(args: unknown, details: unknown): { readonly code: string | null; readonly language: 'js' | 'py' } {
  const cells: string[] = []

  for (const cell of list(details, 'cells')) {
    const body = pick(cell, 'code')

    if (body !== null && body !== '') {
      cells.push(body)
    }
  }

  const given = pick(args, 'code')

  return {
    code: cells.length > 0 ? cells.join('\n\n') : given === '' ? null : given,
    language: pick(args, 'language') === 'py' ? 'py' : 'js',
  }
}

function partsOf(result: unknown): readonly unknown[] {
  const content = bag(result).content

  return Array.isArray(content) ? content : []
}

function textOf(result: unknown): string {
  const joined = partsOf(result)
    .filter((part) => bag(part).type === 'text')
    .map((part) => pick(part, 'text') ?? '')
    .join('\n')

  return joined.length > TEXT_CAP ? `${joined.slice(0, TEXT_CAP)}…` : joined
}

function inlineSrcOf(part: unknown): string | null {
  const record = bag(part)
  const inner = record.type === 'content' ? bag(record.content) : record

  if (inner.type !== 'image') {
    return null
  }

  const data = typeof inner.data === 'string' ? inner.data : null

  return data === null || data === '' ? null : `data:${pick(inner, 'mimeType') ?? DEFAULT_MIME};base64,${data}`
}

function imagesOf(details: unknown, result: unknown): readonly { readonly src: string; readonly alt: string }[] {
  const images: { src: string; alt: string }[] = []
  const seen = new Set<string>()

  const push = (src: string | null): void => {
    if (src !== null && !seen.has(src)) {
      seen.add(src)
      images.push({ src, alt: IMAGE_ALT })
    }
  }

  for (const image of list(details, 'images')) {
    if (bag(image).type === 'image') {
      push(inlineSrcOf(image))
    }
  }

  for (const part of partsOf(result)) {
    push(inlineSrcOf(part))
  }

  return images
}

function firstParagraph(text: string): string | null {
  const cut = /\n\s*\n/u.exec(text)
  const head = (cut === null ? text : text.slice(0, cut.index)).trim()

  return head === '' ? null : head
}

export function browserCallModel(args: unknown, result: unknown, failed: boolean): BrowserCallModel {
  const details = bag(result).details
  const { code, language } = codeOf(args, details)
  const text = textOf(result)
  const steps = stepsOf(details)

  return {
    steps,
    code,
    language,
    text,
    images: imagesOf(details, result),
    error: failed ? (firstParagraph(text) ?? '浏览器操作失败') : null,
  }
}
