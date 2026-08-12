import type { ConversationTurn } from '@poietica/agent'

/*
 * 轨道的度量与分格模型：一格多高、一格在哪、最多几格、一格装几轮。一处回答，
 * 行为 hook 只消费，不各自重算。
 *
 * 分格是轮次的纯函数，这是导航条能用的前提：滚动条的滑块、编辑器 overview ruler
 * 上的标记，数量与位置都只随内容变，不随视口变 —— 「第 40 轮大概在那个高度」这类
 * 空间记忆就建立在这上面。高亮（activeRow）只挑格，不改格。
 */

/**
 * 一格的行距：命中区 12px，不留间距，与 conversation-minimap.css 的 --cp-rail-hit
 * 一致。
 *
 * 必须是 4 的倍数。Windows 的显示缩放是 25% 的整数倍，1 CSS px 因此等于 k/4 个
 * 设备像素；步距一旦不是 4 的倍数，每一格的小数相位就逐格漂移，同样声明的横条
 * 被栅格化成深浅不同的几种。12 乘任何 k/4 都是整数。
 *
 * 写死而不是从计算样式里读回来：读回来要每次布局刷新一次，而这个数只有改
 * 样式表的人会动，让它在两处同时改是比一次同步读更小的代价。
 */
export const RAIL_PITCH_PX = 12

/**
 * 第 index 格的中线，在轨道自身的坐标里。
 *
 * 算出来的，不是量出来的。样式表把每格声明成 block-size: var(--cp-rail-hit) 且
 * flex-shrink: 0，轨道本身没有内边距，格与格之间没有间距 —— 所以第 index 格的
 * 上沿就是 index × 步距，一个字都不必问布局。offsetTop 会给出同一个数，代价是
 * 强制 flush 一遍布局。
 *
 * 它在这里而不是在某个 hook 里，是因为鱼眼和预览卡都要这个数。同一个量两处各算
 * 一遍，就是两处可以各自算错。
 */
export const railCentre = (index: number): number => index * RAIL_PITCH_PX + RAIL_PITCH_PX / 2

/**
 * 轨道最多几格。
 *
 * 「一根杠是一轮」是这个控件对人的承诺，所以并格越晚越好；封顶来自几何而不是
 * 品味：32 格 × 12px = 384px，窗口的 minHeight 是 600（conversation-minimap.css
 * 同一事实），面板竖向放得下，样式表的 max-block-size 只是护栏。超过 32 轮才
 * 并格，而并格只由轮数决定 —— 格数与格的身份都不随滚动位置变。
 */
export const RAIL_MAX_BARS = 32

/**
 * 轨道上的一格。
 *
 * 它不是轮次 —— 轮次是时间线的事实，这是把事实映射到有限像素之后的结果。两者
 * 分开命名，是为了让「一格代表多轮」成为类型上说得出口的事，而不是靠约定。
 */
export type RailItem =
  | {
      readonly kind: 'turn'
      readonly id: string
      readonly rowIndex: number
      readonly ordinal: number
      readonly label: string
      readonly reply?: string
    }
  | {
      readonly kind: 'cluster'
      readonly id: string
      readonly rowIndex: number
      /** 1 起的闭区间，播报用。 */
      readonly from: number
      readonly to: number
      readonly label: string
      readonly reply?: string
    }

function replyOf(turn: ConversationTurn): { readonly reply?: string } {
  return turn.reply === undefined ? {} : { reply: turn.reply }
}

/** 单格就是一轮。ordinal 是整场对话里的序号，不是段内序号。 */
function one(turn: ConversationTurn, index: number): RailItem {
  return {
    kind: 'turn',
    id: turn.id,
    rowIndex: turn.rowIndex,
    ordinal: index + 1,
    label: turn.label,
    ...replyOf(turn),
  }
}

/**
 * 把 [from, to) 这一段收成一格。
 *
 * 段首代表整段：它的 rowIndex 是这一段的入口，点它落在段首而不是段中，符合
 * 「跳到某一段」的意图。只有一轮时退化成单格，不套 cluster 的壳 —— 播报「第
 * 7–7 轮」是在说废话。
 */
function fold(turns: readonly ConversationTurn[], from: number, to: number, out: RailItem[]): void {
  const head = turns[from]

  if (head === undefined) {
    return
  }

  if (to - from <= 1) {
    out.push(one(head, from))

    return
  }

  out.push({
    kind: 'cluster',
    id: head.id,
    rowIndex: head.rowIndex,
    from: from + 1,
    to,
    label: head.label,
    ...replyOf(head),
  })
}

/**
 * 轮次 → 格子。装得下就一轮一格；装不下就等宽切段，段长 ceil(N/格数)。
 *
 * 不做 focus+context 的动态并格。上一版把滚动位置（焦点）喂进了分格，格子的数量
 * 与身份随人上下滚动而变 —— 一轮都没多，导航条却在眼前增减横条。导航的第一性质
 * 是稳：标记要能被记住，才谈得上「跳回去」。近处放大是预览卡与鱼眼的职责，不该
 * 由分格再做一遍。
 *
 * rowIndex 严格递增是构造保证的：按先后切段、段首代表段。turnIndexAtRow 的二分
 * 依赖这一点，不能破坏。
 */
export function groupTurns(
  turns: readonly ConversationTurn[],
  capacity: number,
): readonly RailItem[] {
  if (turns.length === 0) {
    return []
  }

  const slots = Math.max(1, Math.floor(capacity))

  if (turns.length <= slots) {
    return turns.map((turn, index) => one(turn, index))
  }

  const size = Math.ceil(turns.length / slots)
  const items: RailItem[] = []

  for (let index = 0; index < turns.length; index += size) {
    fold(turns, index, Math.min(index + size, turns.length), items)
  }

  return items
}
