import type { Element, ElementContent, Root, RootContent, Text } from 'hast'
import { planWave, WAVE, type WaveOptions, type WaveSegment, waveSettledAt } from './wave-plan'

/*
 * 流式正文的「批次波浪淡入」（P-03）：每批新到的文字切成小段错开启动，波首尾相接。这一层只打标记；动画由 wave-dom.ts 在提交后挂上，
 * 并把 startTime 钉在小段的绝对启动时刻 —— React 复用或挪动 DOM 都不会让动画重播或被截断，且同一时刻的 span 数有上限，与回复长度无关。
 */

export { WAVE, type WaveOptions } from './wave-plan'

/** 这些子树不拆字：代码块由专门组件画，图与 MathML 拆了会坏 */
const OPAQUE = new Set(['pre', 'svg', 'math', 'annotation'])
/** 这些元素整体算一个「字」；行内 code 要外包一层 span —— 数学插件排在本插件之后，KaTeX 会把 code 元素整个换掉。 */
const UNIT = new Set(['img', 'hr', 'code'])
const WRAPPED_UNIT = new Set(['code'])
const UNIT_MARK = '\uFFFC'
/** 最近几个块的账：Streamdown 重新分块时，旧块可能再渲染一次 */
const MAX_BLOCKS = 8
/** 末尾允许「改写」的长度：未闭合的链接、强调等在补全前后渲染出的末尾几个字会变；这种情形要认作同一块还需至少 MIN_SHARED 的最短公共前缀 */
const TAIL_REWRITE = 16
const MIN_SHARED = 8

export const WAVE_START_ATTRIBUTE = 'data-wave-start'
export const WAVE_MARKER_ATTRIBUTE = 'data-wave-marker'

interface BlockLedger {
  text: string
  segments: WaveSegment[]
}

type Atom =
  | { readonly kind: 'text'; readonly node: Text; readonly parent: Element | Root; readonly at: number }
  | { readonly kind: 'unit'; readonly node: Element; readonly parent: Element | Root; readonly at: number }

interface ListItem {
  readonly node: Element
  readonly first: number
}

const isElement = (node: RootContent | ElementContent): node is Element => node.type === 'element'

interface Collected {
  readonly atoms: Atom[]
  readonly items: ListItem[]
  readonly parts: string[]
  at: number
}

function addText(acc: Collected, node: Text, parent: Element | Root): void {
  /* 块之间的换行这类纯空白节点看不见，而且会排在「新字」后面，不计入 */
  if (node.value.trim().length === 0) return
  acc.atoms.push({ kind: 'text', node, parent, at: acc.at })
  acc.parts.push(node.value)
  acc.at += node.value.length
}

function addUnit(acc: Collected, node: Element, parent: Element | Root): void {
  acc.atoms.push({ kind: 'unit', node, parent, at: acc.at })
  acc.parts.push(UNIT_MARK)
  acc.at += 1
}

function visit(acc: Collected, child: RootContent | ElementContent, parent: Element | Root): void {
  if (child.type === 'text') {
    addText(acc, child, parent)
    return
  }
  if (!isElement(child) || OPAQUE.has(child.tagName)) return
  if (UNIT.has(child.tagName)) {
    addUnit(acc, child, parent)
    return
  }
  const before = acc.atoms.length
  for (const grandchild of child.children) visit(acc, grandchild, child)
  if (child.tagName === 'li') acc.items.push({ node: child, first: acc.atoms[before]?.at ?? -1 })
}

function collect(tree: Root): { atoms: Atom[]; items: ListItem[]; text: string } {
  const acc: Collected = { atoms: [], items: [], parts: [], at: 0 }
  for (const child of tree.children) visit(acc, child, tree)
  return { atoms: acc.atoms, items: acc.items, text: acc.parts.join('') }
}

function sharedPrefix(a: string, b: string): number {
  if (b.startsWith(a)) return a.length
  if (a.startsWith(b)) return b.length
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a.charCodeAt(i) === b.charCodeAt(i)) i++
  /* 不停在代理对中间 */
  if (i > 0 && i < limit) {
    const code = a.charCodeAt(i - 1)
    if (code >= 0xd800 && code <= 0xdbff) i--
  }
  return i
}

const markOf = (seg: WaveSegment): string => String(Math.round(seg.start * 10) / 10)

const waveSpan = (seg: WaveSegment, children: ElementContent[]): Element => ({
  type: 'element',
  tagName: 'span',
  properties: { [WAVE_START_ATTRIBUTE]: markOf(seg) },
  children,
})

function segmentAt(segments: readonly WaveSegment[], at: number): WaveSegment | undefined {
  const first = segments[0]
  if (first === undefined || at < first.from) return undefined
  return segments.find((s) => at >= s.from && at < s.to)
}

function markItems(items: readonly ListItem[], segments: readonly WaveSegment[]): void {
  for (const item of items) {
    const seg = segmentAt(segments, item.first)
    if (seg !== undefined) item.node.properties = { ...item.node.properties, [WAVE_MARKER_ATTRIBUTE]: markOf(seg) }
  }
}

function paintUnit(atom: Extract<Atom, { kind: 'unit' }>, segments: readonly WaveSegment[]): void {
  const seg = segmentAt(segments, atom.at)
  if (seg === undefined) return
  if (WRAPPED_UNIT.has(atom.node.tagName)) {
    const siblings = atom.parent.children as ElementContent[]
    siblings[siblings.indexOf(atom.node)] = waveSpan(seg, [atom.node])
    return
  }
  atom.node.properties = { ...atom.node.properties, [WAVE_START_ATTRIBUTE]: markOf(seg) }
}

function splitText(value: string, at: number, segments: readonly WaveSegment[]): ElementContent[] {
  const end = at + value.length
  const out: ElementContent[] = []
  let cut = 0
  for (const seg of segments) {
    const a = Math.max(seg.from, at) - at
    const b = Math.min(seg.to, end) - at
    if (b <= a) continue
    if (a > cut) out.push({ type: 'text', value: value.slice(cut, a) })
    out.push(waveSpan(seg, [{ type: 'text', value: value.slice(a, b) }]))
    cut = b
  }
  if (out.length > 0 && cut < value.length) out.push({ type: 'text', value: value.slice(cut) })
  return out
}

function paintText(atom: Extract<Atom, { kind: 'text' }>, segments: readonly WaveSegment[]): void {
  const first = segments[0]
  if (first === undefined || atom.at + atom.node.value.length <= first.from) return
  const out = splitText(atom.node.value, atom.at, segments)
  if (out.length === 0) return
  const siblings = atom.parent.children as ElementContent[]
  siblings.splice(siblings.indexOf(atom.node), 1, ...out)
}

function paint(atoms: readonly Atom[], items: readonly ListItem[], segments: readonly WaveSegment[]): void {
  if (segments.length === 0) return
  markItems(items, segments)
  for (const atom of atoms) {
    if (atom.kind === 'unit') paintUnit(atom, segments)
    else paintText(atom, segments)
  }
}

export interface WaveReveal {
  /** rehype 插件，放在净化链之后；名字必须唯一 —— Streamdown 按插件名缓存处理器 */
  readonly attacher: () => (tree: Root) => void
  /** 首个挂着插件的提交之后调用：此前已有的字一律不做动画 */
  arm(): void
  disarm(): void
  /** 最后一段淡完的时刻；摘插件要等到它之后，否则最后一波会被截断 */
  busyUntil(): number
}

let serial = 0

export function createWaveReveal(options: WaveOptions = WAVE, now: () => number = () => performance.now()): WaveReveal {
  let armed = false
  let blocks: BlockLedger[] = []
  /** 下一段最早何时启动：跨批、跨块共用，让波首尾相接 */
  let cursor = 0
  let busy = 0

  /** 找这一块的账：纯追加，或只改写了末尾几个字，都算同一块 */
  const ledgerFor = (text: string): { ledger: BlockLedger; known: number } => {
    for (let i = 0; i < blocks.length; i++) {
      const ledger = blocks[i]!
      if (ledger.text.length === 0) continue
      const shared = sharedPrefix(ledger.text, text)
      const appended = shared === ledger.text.length
      const rewritten = shared >= MIN_SHARED && shared >= Math.min(ledger.text.length, text.length) - TAIL_REWRITE
      if (appended || rewritten) {
        blocks.splice(i, 1)
        blocks.unshift(ledger)
        return { ledger, known: shared }
      }
    }
    const ledger: BlockLedger = { text: '', segments: [] }
    blocks.unshift(ledger)
    if (blocks.length > MAX_BLOCKS) blocks.length = MAX_BLOCKS
    return { ledger, known: 0 }
  }

  const schedule = (ledger: BlockLedger, text: string, known: number, t: number): void => {
    const plan = planWave(text, known, t, cursor, options)
    if (plan.segments.length === 0) return
    ledger.segments.push(...plan.segments)
    cursor = plan.cursor
    busy = Math.max(busy, plan.busyUntil)
  }

  const transform = (tree: Root): void => {
    const { atoms, items, text } = collect(tree)
    const t = now()
    const { ledger, known } = ledgerFor(text)
    if (!armed) {
      ledger.text = text
      ledger.segments = []
      return
    }
    /* 淡完的并回正文；被改写掉的那截不再画 */
    ledger.segments = ledger.segments.filter((s) => s.to <= known && t < waveSettledAt(s, options))
    if (text.length > known) schedule(ledger, text, known, t)
    ledger.text = text
    paint(atoms, items, ledger.segments)
  }

  const id = ++serial
  const attacher = () => transform
  Object.defineProperty(attacher, 'name', { value: `rehypeWaveReveal$${String(id)}` })

  return {
    attacher,
    arm() {
      armed = true
    },
    disarm() {
      armed = false
      blocks = []
      cursor = 0
      busy = 0
    },
    busyUntil: () => busy,
  }
}
