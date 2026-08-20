import type { ToolCallContent } from '@poietica/agent-contract'
import { diffLines } from 'diff'

/**
 * The protocol envelope, flattened into things a card can draw.
 *
 * Kept separate from the component and free of React on purpose: what a tool
 * call shows is a decision worth testing against a real recording, while how it
 * is laid out is not.
 *
 * Content blocks other than text are named rather than rendered. Guessing at
 * the shape of an image or a resource block is what produced the last defect;
 * these get drawn when a recording contains one.
 *
 * 它住在 domain。这里没有一行 React，做的是「协议信封 → 可显示的片段」这一次投影，
 * 与 composer/question-answer 同类。此前它住在 timeline/，于是 domain 想读一段
 * content 就得反着依赖表现层 —— 手搓的 unknown 收窄正是这么长出来的。
 */

export type ToolContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'diff'
      readonly path: string
      readonly oldText: string | null
      readonly newText: string
    }
  | { readonly type: 'terminal'; readonly terminalId: string }
  | { readonly type: 'link'; readonly uri: string; readonly name: string | null }
  | { readonly type: 'opaque'; readonly label: string }
  | { readonly type: 'command'; readonly command: string; readonly language: string }
  | { readonly type: 'prose'; readonly text: string }
  | {
      readonly type: 'todo'
      readonly items: readonly {
        readonly title: string
        readonly status: 'done' | 'in_progress' | 'pending'
      }[]
    }

/* 内层的块只有 text / image / audio 三种（agent-contract 的 ToolCallContent），
   所以这张表只为画不出来的那两种留名字。resource 与 resource_link 是外层的档，
   此前挂在这里的两个键一次都取不到。 */
const OPAQUE_LABELS: Record<string, string> = {
  audio: '一段音频',
  image: '一张图片',
}

/** 一份嵌入资源：带正文就当正文画，只有字节时才退回链接。 */
function resourcePart(resource: {
  readonly uri: string
  readonly text?: string | undefined
}): ToolContentPart {
  const text = resource.text

  return text === undefined || text === ''
    ? { type: 'link', uri: resource.uri, name: null }
    : { type: 'text', text }
}

/** 协议信封里那层内块：text / image / audio 三种，只有 text 画得出来。 */
function blockPart(block: {
  readonly type: string
  readonly text?: string
}): ToolContentPart | null {
  if (block.type === 'text') {
    /* A tool call opens with an empty string and fills in as arguments
       stream. An empty bubble is noise, not information. */
    return block.text === undefined || block.text.length === 0
      ? null
      : { type: 'text', text: block.text }
  }

  return { type: 'opaque', label: OPAQUE_LABELS[block.type] ?? '一段内容' }
}

/**
 * 一枚内容块画成什么。一档一个 return，唯一的判别式主干。
 *
 * 送出去那一面的三档（command / prose / todo）也在这里：它们与信封无关，
 * 是投影层照 kap 的 display 映来的。空的散文与清单不出格。
 */
function partOf(entry: ToolCallContent): ToolContentPart | null {
  switch (entry.type) {
    case 'command': {
      return { type: 'command', command: entry.command, language: entry.language }
    }

    case 'prose': {
      return entry.text.length === 0 ? null : { type: 'prose', text: entry.text }
    }

    case 'todo': {
      return entry.items.length === 0 ? null : { type: 'todo', items: entry.items }
    }

    case 'diff': {
      return {
        type: 'diff',
        path: entry.path,
        oldText: entry.oldText ?? null,
        newText: entry.newText,
      }
    }

    case 'terminal': {
      return { type: 'terminal', terminalId: entry.terminalId }
    }

    /* 这两档没有 content 那一格，此前一路落到下面那行去读它。 */
    case 'resource_link': {
      return { type: 'link', uri: entry.uri, name: entry.name ?? null }
    }

    case 'resource': {
      return resourcePart(entry.resource)
    }

    case 'content': {
      return blockPart(entry.content)
    }
  }
}

export function toToolContentParts(
  content: readonly ToolCallContent[] | null | undefined,
): readonly ToolContentPart[] {
  if (content === undefined || content === null) {
    return []
  }

  const parts: ToolContentPart[] = []

  for (const entry of content) {
    const part = partOf(entry)

    if (part !== null) {
      parts.push(part)
    }
  }

  return parts
}

export interface DiffStat {
  readonly added: number
  readonly removed: number
}

/**
 * 这次调用改了多少行。
 *
 * 只有真的带了 diff 才有答案：读文件、搜索、跑终端都不是改动，给它们挂一个
 * +0 −0 的徽章是在制造噪音。协议给的是改动前后的整份文本，所以行级增删是一次
 * 真实比对的结果，不是拿行数相减估出来的 —— 那会把"改了一行"读成"没动过"。
 *
 * 比对交给 jsdiff：Myers 差分是有标准答案的问题，手写一份只会多一份要维护的
 * 边界情况。新建文件没有前一版，整份文本都是新增。
 *
 * 不再对外：Myers 是 O(N·D)，一个随手可调的导出等于邀请下一个人在渲染路径上
 * 再调一次。结果只经 toToolCallView 出去，那里记着。
 */
function diffStatOf(parts: readonly ToolContentPart[]): DiffStat | null {
  let added = 0
  let removed = 0
  let sawDiff = false

  for (const part of parts) {
    if (part.type !== 'diff') {
      continue
    }

    sawDiff = true

    for (const change of diffLines(part.oldText ?? '', part.newText)) {
      if (change.added === true) {
        added += change.count ?? 0
        continue
      }

      if (change.removed === true) {
        removed += change.count ?? 0
      }
    }
  }

  return sawDiff ? { added, removed } : null
}

/** 一次工具调用画出来需要的全部东西，一趟算完。 */
export interface ToolCallView {
  readonly parts: readonly ToolContentPart[]
  /** 这次调用改了多少行；没带 diff 时是 null。 */
  readonly diffStat: DiffStat | null
}

/** 没有调用就没有内容。常量，免得每次问都造一个新对象。 */
const EMPTY_VIEW: ToolCallView = { diffStat: null, parts: [] }

const VIEWS = new WeakMap<readonly ToolCallContent[], ToolCallView>()

/**
 * 上面那两步，按 content 记一次。
 *
 * 键就是 content 数组本身 —— 它是这个投影唯一的输入，也已经是个对象。此前键是
 * 「带着 content 的那个容器」，那需要专门发明一个接口才能让两种容器都塞得进来，
 * 而且时间线上那条调用和权限请求随身带来的那一次是两个不同的容器：同一份内容会
 * 被解析两遍。按 content 记就没有这回事，谁带着它都不重要。
 *
 * 引用稳定是构造保证的，不是约定：reducer 冻结每一个 item，任何变更都造新对象，
 * 事件里读出来的那份读完就不再改。
 *
 * 不用 useMemo。转录区是虚拟化的，卡片滚出视口就卸载，useMemo 的缓存跟着一起
 * 走 —— 偏偏在长会话里最需要它的时候失效。WeakMap 的生命周期跟着数据而不是跟着
 * 组件实例，旧内容被回收时缓存自动消失，不需要任何淘汰策略。
 *
 * 值得记的原因是它不便宜：diffStatOf 里是 Myers 差分，而两张卡的函数体都在渲染
 * 路径上。
 *
 * 「流式期间每一张可见卡片都在重解析」曾经是这里的理由，今天不成立了：feed-rows
 * 的 toRow 把行对象记在条目上，一条没被碰过的工具调用相邻两帧交回的是同一个
 * FeedRow，而 TimelineRow 的 memo 判据正是它 —— 已经落定的那些卡片的函数体一次都
 * 不跑，turn-identity.test.ts 守着这条。上游挡住了，这里就不该再宣称自己在挡同一
 * 件事：一份缓存靠一个不再发生的场景辩护，下一个人无从判断它还该不该在。
 *
 * 留着它，是为了另一条真实的路径：一道提问的 content 会被两个互不相识的地方读到
 * —— 输入框那副题组在 surface 的 useMemo 里读一次（readQuestionPrompt），流里那张
 * 结果卡在 QuestionOutcome 里再读一次，两者之间没有任何共享的组件缓存。键是 content
 * 数组本身，所以谁带着它、经不经过 memo 都不重要，解析只发生一次。
 *
 * 此前这里写的理由是「权限请求由 surface 直接画，memo 够不着」。permission 那一支
 * 交回 TimelineRow 之后那条路径不存在了，理由跟着换成上面这条真的 —— 一份缓存靠一
 * 个不再发生的场景辩护，下一个人无从判断它还该不该在。
 */
export function toToolCallView(
  content: readonly ToolCallContent[] | null | undefined,
): ToolCallView {
  if (content === null || content === undefined) {
    return EMPTY_VIEW
  }

  const held = VIEWS.get(content)

  if (held !== undefined) {
    return held
  }

  const parts = toToolContentParts(content)
  const view: ToolCallView = { diffStat: diffStatOf(parts), parts }

  VIEWS.set(content, view)

  return view
}
