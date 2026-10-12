/*
 * 浏览器卡片的数据层：只认 omp 18.5 的 eval 形状（浏览器是 eval 的 prelude，不是顶层工具）。
 * 拆成纯函数是为了能脱离 React 钉住每一种产出形状。
 *
 * 正本在产出里，不在入参里：一次 `browser.open(...)` 经 `describeBrowserCall`
 * （omp/src/tools/browser.ts）写一条 `{ op: 'browser', detail: 'open main https://…' }`，
 * 落在 `details.statusEvents` 与 `details.cells[].statusEvents`；截图落在 `details.images[]`。
 * 入参只有 `{ language, code, title }` —— 按旧顶层工具的 `args.action / args.url` 读，
 * 读到的永远是空的。
 */

import type { BrowserState } from '../contract'

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
  readonly lastUrl: string | null // 最后一次 open 的地址，「在面板中查看」用
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

/** 事件既可能挂在整次调用上，也可能挂在产生它的那个 cell 上。 */
function statusEventsOf(details: unknown): readonly unknown[] {
  const events = [...list(details, 'statusEvents')]

  for (const cell of list(details, 'cells')) {
    events.push(...list(cell, 'statusEvents'))
  }

  return events
}

/** 只取浏览器那几笔：`computer` 等别的 prelude 不是浏览器动作。 */
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

/** `<tab>.<method>(…)…` 的第一层括号内容；没有括号或括号没闭合就是 null。 */
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

/** 去引号的字段：`"https://a.com"` 与 `'#go'` 都该读成裸值。 */
function unquote(text: string): string {
  const trimmed = text.trim()
  const first = trimmed.at(0)
  const last = trimmed.at(-1)

  return trimmed.length >= 2 && (first === '"' || first === "'" || first === '`') && last === first
    ? trimmed.slice(1, -1)
    : trimmed
}

type Scan = { readonly quote: string | null; readonly depth: number; readonly stop: boolean }

/** 扫一格：引号、括号深度，以及「从这里断开」——顶层逗号只认第一层。 */
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

/** 括号里第一段参数（顶层逗号之前），去引号；调用链的其余部分由目标自己带着。 */
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

/** `<tab>.<method>(…)`：动作是方法名，目标取第一段参数。 */
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

/** 上游写的那句 detail → 卡片画的一步。每一档都留着原话，认不出时也不是一片空白。 */
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

/** 内联图（旧形状，relay 能带回像素时才有）：只认 data，别的都不当位图。 */
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

/** 失败时先说第一段：后面往往是调用栈，折叠行上要的是那句人话。 */
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
  let lastUrl: string | null = null

  for (const step of steps) {
    if (step.action === 'open' && step.target !== null) {
      lastUrl = step.target
    }
  }

  return {
    steps,
    code,
    language,
    text,
    images: imagesOf(details, result),
    error: failed ? (firstParagraph(text) ?? '浏览器操作失败') : null,
    lastUrl,
  }
}

/** 地址的同一性：hash 不算（`#a` 与 `#b` 是同一页的两次跳转，仍是那张标签）。 */
function withoutHash(address: string): string | null {
  try {
    const url = new URL(address)

    return `${url.origin}${url.pathname}${url.search}`
  } catch {
    return null
  }
}

/** 卡片对应哪张标签：先按地址精确匹配（忽略 hash），再退到同源；都没有就不切，只开面板。 */
export function revealTabFor(state: BrowserState, lastUrl: string | null): number | null {
  const wanted = lastUrl === null ? null : withoutHash(lastUrl)

  if (wanted === null) {
    return null
  }

  const origin = wanted.slice(0, wanted.indexOf('/', wanted.indexOf('://') + 3))

  for (const tab of state.tabs) {
    if (tab.url !== null && withoutHash(tab.url) === wanted) {
      return tab.id
    }
  }

  for (const tab of state.tabs) {
    const address = tab.url === null ? null : withoutHash(tab.url)

    if (address !== null && origin !== '' && address.startsWith(`${origin}/`)) {
      return tab.id
    }
  }

  return null
}
