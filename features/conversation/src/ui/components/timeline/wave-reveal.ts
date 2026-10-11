import type { Element, ElementContent, Root, RootContent, Text } from 'hast'

/*
 * 流式正文的「批次波浪淡入」（P-03）。
 *
 * 每批新到的文字切成若干小段，小段依次错开启动淡入；相邻批次的波首尾相接，于是
 * 最近一小段时间里到的字形成一条「越旧越实、越新越淡」的渐变带，跟着正文末尾前进。
 *
 * 这一层只负责「标记」：把仍在淡入中的小段包成 <span data-wave-start="…">，淡完的字
 * 并回普通文本。真正的动画由 wave-dom.ts 在提交后用 Web Animations 挂上，并把每个
 * 动画的 startTime 钉在小段的绝对启动时刻 —— React 复用或挪动 DOM 节点都不会让动画
 * 重播或被截断。同一时刻的 span 数有上限，与回复长度无关。
 */

export interface WaveOptions {
  /** 一小段从透明到实的时长 */
  readonly fadeMs: number
  /** 相邻小段的启动间隔上限 */
  readonly stepMs: number
  /** 一批的波最多铺开多久；也是跨批排队的积压上限 */
  readonly spreadMs: number
  /** 一小段至少几个字素（太碎就退化成逐字，span 数也会涨） */
  readonly minSegment: number
  /** 一批最多切几段 */
  readonly maxSegments: number
  /** 一批超过这么多字素（如从后台切回）：只给最后 hugeTail 个做动画，前面的直接实显 */
  readonly hugeBatch: number
  readonly hugeTail: number
  /** 判定「已淡完」时额外等的时间：插件在渲染期运行，DOM 提交还要晚一点 */
  readonly settleMarginMs: number
  /** 一次提交里最多新起几个动画；超出的（靠前的）直接实显 —— 从后台切回时不让整屏一起淡 */
  readonly maxFreshPerCommit: number
}

export const WAVE: WaveOptions = {
  fadeMs: 320,
  stepMs: 30,
  spreadMs: 240,
  minSegment: 6,
  maxSegments: 24,
  hugeBatch: 1500,
  hugeTail: 600,
  settleMarginMs: 80,
  maxFreshPerCommit: 64,
}

/** 这些子树不拆字：代码块由专门组件画，图与 MathML 拆了会坏 */
const OPAQUE = new Set(['pre', 'svg', 'math', 'annotation'])
/**
 * 这些元素整体算一个「字」：新出现时整个元素淡入。
 * img/hr 直接打标记；行内 code（含 remark-math 产出的 code.math-inline）外包一层 span ——
 * 数学插件排在本插件之后，KaTeX 会把 code 元素整个换掉，标记打在外层才留得住。
 */
const UNIT = new Set(['img', 'hr', 'code'])
const WRAPPED_UNIT = new Set(['code'])
/** 单元在拼接文本里的占位（对象替换字符） */
const UNIT_MARK = '\uFFFC'
/** 最近几个块的账：Streamdown 重新分块时，旧块可能再渲染一次 */
const MAX_BLOCKS = 8
/** 末尾允许「改写」的长度：未闭合的链接、强调等在补全前后，渲染出的末尾几个字会变 */
const TAIL_REWRITE = 16
/** 认作「同一块」所需的最短公共前缀（末尾改写的情形）；纯追加不受此限 */
const MIN_SHARED = 8

export const WAVE_START_ATTRIBUTE = 'data-wave-start'
export const WAVE_MARKER_ATTRIBUTE = 'data-wave-marker'

interface Segment {
  readonly from: number
  readonly to: number
  /** 绝对启动时刻（performance.now 时基，与 document.timeline 同源） */
  readonly start: number
}

interface BlockLedger {
  text: string
  segments: Segment[]
}

type Atom =
  | { readonly kind: 'text'; readonly node: Text; readonly parent: Element | Root; readonly at: number }
  | { readonly kind: 'unit'; readonly node: Element; readonly parent: Element | Root; readonly at: number }

interface ListItem {
  readonly node: Element
  /** 这一项第一个原子的位置；没有原子的项记 -1 */
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

/** 收集原子、列表项，并拼出可比对的文本。O(块大小)，与 Streamdown 解析这一块同阶。 */
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

let segmenter: Intl.Segmenter | undefined
/** 新到文字的字素边界（绝对偏移，含两端）。只切新到的那一段。 */
function graphemeEdges(text: string, base: number): number[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const edges: number[] = []
  for (const { index } of segmenter.segment(text.slice(base))) edges.push(base + index)
  edges.push(text.length)
  return edges
}

const markOf = (seg: Segment): string => String(Math.round(seg.start * 10) / 10)

const waveSpan = (seg: Segment, children: ElementContent[]): Element => ({
  type: 'element',
  tagName: 'span',
  properties: { [WAVE_START_ATTRIBUTE]: markOf(seg) },
  children,
})

/** 这个位置落在哪一段（段按位置升序，第一段之前的一律不在飞） */
function segmentAt(segments: readonly Segment[], at: number): Segment | undefined {
  const first = segments[0]
  if (first === undefined || at < first.from) return undefined
  return segments.find((s) => at >= s.from && at < s.to)
}

function markItems(items: readonly ListItem[], segments: readonly Segment[]): void {
  for (const item of items) {
    const seg = segmentAt(segments, item.first)
    if (seg !== undefined) item.node.properties = { ...item.node.properties, [WAVE_MARKER_ATTRIBUTE]: markOf(seg) }
  }
}

function paintUnit(atom: Extract<Atom, { kind: 'unit' }>, segments: readonly Segment[]): void {
  const seg = segmentAt(segments, atom.at)
  if (seg === undefined) return
  if (WRAPPED_UNIT.has(atom.node.tagName)) {
    const siblings = atom.parent.children as ElementContent[]
    siblings[siblings.indexOf(atom.node)] = waveSpan(seg, [atom.node])
    return
  }
  atom.node.properties = { ...atom.node.properties, [WAVE_START_ATTRIBUTE]: markOf(seg) }
}

/** 把一个文本节点按在飞的段切开；没有在飞的字时返回空数组 */
function splitText(value: string, at: number, segments: readonly Segment[]): ElementContent[] {
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

function paintText(atom: Extract<Atom, { kind: 'text' }>, segments: readonly Segment[]): void {
  const first = segments[0]
  if (first === undefined || atom.at + atom.node.value.length <= first.from) return
  const out = splitText(atom.node.value, atom.at, segments)
  if (out.length === 0) return
  const siblings = atom.parent.children as ElementContent[]
  siblings.splice(siblings.indexOf(atom.node), 1, ...out)
}

/** 把仍在淡入中的小段落成 span；其余保持普通文本 */
function paint(atoms: readonly Atom[], items: readonly ListItem[], segments: readonly Segment[]): void {
  if (segments.length === 0) return
  markItems(items, segments)
  for (const atom of atoms) {
    if (atom.kind === 'unit') paintUnit(atom, segments)
    else paintText(atom, segments)
  }
}

export interface WaveReveal {
  /** rehype 插件（attacher），放在净化链之后。名字唯一：Streamdown 按插件名缓存处理器 */
  readonly attacher: () => (tree: Root) => void
  /** 首个挂着插件的提交之后调用：此前已有的字一律不做动画 */
  arm(): void
  /** 摘下插件时调用：清账 */
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
    let edges = graphemeEdges(text, known)
    if (edges.length - 1 > options.hugeBatch) edges = edges.slice(edges.length - 1 - options.hugeTail)
    const count = edges.length - 1
    if (count <= 0) return
    const pieces = Math.min(options.maxSegments, Math.ceil(count / options.minSegment))
    const step = pieces > 1 ? Math.min(options.stepMs, options.spreadMs / (pieces - 1)) : 0
    /* 接在上一波后面；但积压不超过 spreadMs —— 宁可两波重叠，也不让字迟迟不出 */
    const first = Math.min(Math.max(cursor, t), t + options.spreadMs)
    for (let j = 0; j < pieces; j++) {
      const from = edges[Math.floor((j * count) / pieces)]!
      const to = edges[Math.floor(((j + 1) * count) / pieces)]!
      if (to > from) ledger.segments.push({ from, to, start: first + j * step })
    }
    cursor = first + pieces * step
    busy = Math.max(busy, first + (pieces - 1) * step + options.fadeMs + options.settleMarginMs)
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
    ledger.segments = ledger.segments.filter(
      (s) => s.to <= known && t < s.start + options.fadeMs + options.settleMarginMs,
    )
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
