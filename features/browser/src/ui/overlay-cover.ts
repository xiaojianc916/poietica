import { type OverlayPresence, overlaysOnScreen, subscribeOverlays } from '@poietica/design-system'

/* 原生视图该不该给浮层让路（P-07）。原生子视图摆在整页 DOM 之上，被它压住的浮层根本看不见，只能是视图让开。
 * 谁在场由画浮层的一方登记（design-system 的 overlay-presence），这里只做判定：
 * - 模态浮层（对话框、命令面板、灯箱）铺满窗口，一律让；
 * - 贴着某处开的浮层（菜单、下拉、提示、自绘面板、通知卡）只在和视图那块地相交时才让 ——
 *   开在对话区的提示不该让网页闪一下。 */

export interface Box {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

function intersects(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

/** 纯判定。view 为 null（视图还没占位）时只看有没有模态浮层。 */
export function coversView(
  overlays: readonly OverlayPresence[],
  view: Box | null,
  boxOf: (element: Element) => Box,
): boolean {
  for (const overlay of overlays) {
    if (overlay.kind === 'modal') return true
    if (view !== null && intersects(boxOf(overlay.element), view)) return true
  }
  return false
}

/** 不量几何就下得了的结论：有模态浮层就是盖住，一个浮层都没有就是没盖住，其余要量（返回 null）。 */
function decidedWithoutMeasuring(overlays: readonly OverlayPresence[]): boolean | null {
  if (overlays.some((overlay) => overlay.kind === 'modal')) return true
  return overlays.length === 0 ? false : null
}

/** 此刻能确定的初值（给 useState 用）：只剩贴边浮层时先当没盖住，watchCover 下一帧量过再改。 */
export function coveredNow(): boolean {
  return decidedWithoutMeasuring(overlaysOnScreen()) === true
}

/**
 * 盯住「视图有没有被盖住」，变了才回调（起步时回调一次当前值）。
 *
 * 登记一变，能直接下结论的当场下（模态浮层要在画出来之前就让开）；只剩贴边浮层时推到下一帧再量：
 * 定位器是异步摆位的，挂上的那一刻矩形还不是最终位置，当场量会让视图白白闪一下。贴边浮层在场期间
 * 每帧重量一次（菜单跟着锚点走、面板换宽度都不发登记）；浮层都是短命的，这个循环只在它们在场时跑。
 */
export function watchCover(view: () => Element | null, onChange: (covered: boolean) => void): () => void {
  let covered: boolean | null = null
  let frame = 0

  const report = (next: boolean): void => {
    if (next === covered) return
    covered = next
    onChange(next)
  }

  const measure = (): void => {
    frame = 0
    const overlays = overlaysOnScreen()
    const element = view()
    report(
      coversView(overlays, element === null ? null : element.getBoundingClientRect(), (overlay) =>
        overlay.getBoundingClientRect(),
      ),
    )
    if (overlays.some((overlay) => overlay.kind === 'anchored')) frame = requestAnimationFrame(measure)
  }

  const onPresence = (): void => {
    const decided = decidedWithoutMeasuring(overlaysOnScreen())
    if (decided !== null) report(decided)
    else if (frame === 0) frame = requestAnimationFrame(measure)
  }

  const stop = subscribeOverlays(onPresence)
  onPresence()

  return () => {
    stop()
    if (frame !== 0) cancelAnimationFrame(frame)
    frame = 0
  }
}
