import type { WorkbenchTabId } from './workbench'

export interface WorkbenchTabModelItem {
  readonly id: WorkbenchTabId

  readonly canClose: boolean
}

export type WorkbenchTabKeyboardAction =
  | {
      readonly type: 'activate'

      readonly tabId: WorkbenchTabId
    }
  | {
      readonly type: 'close'

      readonly tabId: WorkbenchTabId
    }

/**
 * 一个标签在标签条上占据的横向区间，拖拽开始时快照一次。
 *
 * 坐标在滚动容器的内容坐标系里，不是视口坐标系：拖拽期间标签条可能自动滚动，视口坐标
 * 快照会整体错位，夹取范围也会缩到当前可见的那几个标签。
 */
export interface WorkbenchTabSlot {
  readonly id: WorkbenchTabId

  readonly start: number

  readonly end: number
}

/**
 * 一次拖拽在某一瞬间的完整布局。
 *
 * 这是 Chromium 标签条 ideal bounds 的最小表达：被拖的那一格由指针定位，其余每一格都有一个
 * "此刻应该画在哪"的目标位移，收敛过程交给 CSS 过渡。
 */
export interface WorkbenchTabDragLayout {
  /** 松手时提交给 onMove 的落点，即被拖标签在结果列表中的位置。 */
  readonly index: number

  /** 与 slots 同序：每一格相对自己静止位置的横向位移，单位 px。 */
  readonly offsets: readonly number[]
}

export function resolveWorkbenchTabKeyboardAction(
  tabs: readonly WorkbenchTabModelItem[],
  currentTabId: WorkbenchTabId,
  key: string,
): WorkbenchTabKeyboardAction | null {
  const currentIndex = tabs.findIndex((tab) => tab.id === currentTabId)

  if (currentIndex < 0 || tabs.length === 0) {
    return null
  }

  if (key === 'Delete') {
    const currentTab = tabs[currentIndex]

    if (!currentTab?.canClose) {
      return null
    }

    return {
      type: 'close',
      tabId: currentTab.id,
    }
  }

  const targetIndex = resolveTargetIndex(key, currentIndex, tabs.length)

  if (targetIndex === null) {
    return null
  }

  const target = tabs[targetIndex]

  if (!target) {
    return null
  }

  return {
    type: 'activate',
    tabId: target.id,
  }
}

export function resolveWorkbenchTabCloseTarget(
  tabs: readonly WorkbenchTabModelItem[],
  closingTabId: WorkbenchTabId,
): WorkbenchTabId | null {
  const closingIndex = tabs.findIndex((tab) => tab.id === closingTabId)

  if (closingIndex < 0 || tabs.length <= 1) {
    return null
  }

  return tabs[closingIndex + 1]?.id ?? tabs[closingIndex - 1]?.id ?? null
}

/*
 * 落点由被拖标签自己的中线决定，不是光标坐标：光标可以按在标签的任意位置，用它算会让
 * "看起来还没盖过去"和"已经换位了"对不上。Chromium 的 TabDragController 同样用被拖视图的
 * 边界求插入位置。
 *
 * 位移取自静止槽位的起点差，而不是"标签宽加间距"：让位的每一格恰好落在前一格原来的起点上，
 * 松手后真实布局给出的就是这个位置，因此提交时不会有回跳。
 */
export function resolveWorkbenchTabDragLayout(
  slots: readonly WorkbenchTabSlot[],
  fromIndex: number,
  pointerDeltaX: number,
): WorkbenchTabDragLayout | null {
  const source = slots[fromIndex]

  const first = slots[0]

  const last = slots[slots.length - 1]

  if (!source || !first || !last) {
    return null
  }

  /* 夹在首尾槽位之间：越界会让标签滑出滚动容器，凭空撑出可滚动区域。 */
  const offset = Math.min(
    Math.max(pointerDeltaX, first.start - source.start),
    last.end - source.end,
  )

  const center = (source.start + source.end) / 2 + offset

  let index = fromIndex

  for (let candidate = fromIndex - 1; candidate >= 0; candidate -= 1) {
    const slot = slots[candidate]

    if (!slot || center > (slot.start + slot.end) / 2) {
      break
    }

    index = candidate
  }

  for (let candidate = fromIndex + 1; candidate < slots.length; candidate += 1) {
    const slot = slots[candidate]

    if (!slot || center < (slot.start + slot.end) / 2) {
      break
    }

    index = candidate
  }

  const offsets = slots.map(() => 0)

  offsets[fromIndex] = offset

  const step = index > fromIndex ? 1 : -1

  for (let position = fromIndex; position !== index; position += step) {
    const vacated = slots[position]

    const moved = slots[position + step]

    if (!vacated || !moved) {
      return null
    }

    offsets[position + step] = vacated.start - moved.start
  }

  return { index, offsets }
}

/*
 * 边缘自动滚动的速度曲线，返回 px/s，负值向左。
 *
 * 变速而不是恒速：恒速档在长标签条上要么慢得没用、要么快得过冲。Chromium 的标签条滚动会话
 * 同样提供变速档。越靠边越快，越过边界后保持满速，指针拖到条外不会得到无穷大的速度。
 *
 * 返回速度而不是每帧位移：位移必须乘以真实帧间隔才与刷新率无关，而帧间隔只有调用方知道。
 *
 * 触发区按可视宽度的一半夹一次：窄标签条上两侧触发区会相遇，此时中点速度恰好为 0，曲线仍然
 * 连续，不需要为"太窄"单开一个什么都不做的分支。
 */
export function resolveWorkbenchTabAutoScrollVelocity(
  viewportStart: number,
  viewportEnd: number,
  pointerX: number,
  edgeZone: number,
  maxSpeed: number,
): number {
  const zone = Math.min(edgeZone, (viewportEnd - viewportStart) / 2)

  if (zone <= 0) {
    return 0
  }

  const leadingDepth = viewportStart + zone - pointerX

  if (leadingDepth > 0) {
    return -Math.min(leadingDepth / zone, 1) * maxSpeed
  }

  const trailingDepth = pointerX - (viewportEnd - zone)

  if (trailingDepth > 0) {
    return Math.min(trailingDepth / zone, 1) * maxSpeed
  }

  return 0
}

export function encodeWorkbenchTabDomId(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, '-')
}

function resolveTargetIndex(key: string, currentIndex: number, tabCount: number): number | null {
  switch (key) {
    case 'ArrowLeft':
      return (currentIndex - 1 + tabCount) % tabCount

    case 'ArrowRight':
      return (currentIndex + 1) % tabCount

    case 'Home':
      return 0

    case 'End':
      return tabCount - 1

    default:
      return null
  }
}
