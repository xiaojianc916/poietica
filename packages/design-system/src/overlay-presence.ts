/*
 * 浮层登记处：此刻屏幕上有哪些浮层、各占哪块地。
 *
 * 谁需要它：桌面端的原生视图（浏览器面板是 Electron 的 WebContentsView）永远画在整页 DOM 之上，
 * z-index 管不到 —— 菜单、下拉、提示、对话框只要和它重叠就会被它盖住，它只能自己让路。以前 browser
 * 功能靠嗅探 DOM 去猜（body 直接子节点里找 [role="dialog"][data-open]），等于依赖本包的内部结构，
 * 而且只认得对话框：Menu、Select、Tooltip、自绘的传送门全漏。
 *
 * 现在由画浮层的一方显式登记：本包的浮层控件在弹层挂载时登记、卸载时注销（离场动画放完才卸载，
 * 所以淡出那几帧也算在场）；包外自绘的浮层（createPortal、第三方灯箱）用同一组钩子登记。
 * 这里只记「谁在场」，不做判定 —— 要不要让路、按什么几何让路，是用的一方的事。
 *
 * - modal：铺满整个窗口的一层（对话框、灯箱）。没有「位置」可言。
 * - anchored：贴着某处开的一块（菜单、下拉、提示、自绘面板）。带元素，用的一方自己量矩形。
 */
import { type Ref, type RefCallback, useCallback, useEffect } from 'react'

export type OverlayPresence = { readonly kind: 'modal' } | { readonly kind: 'anchored'; readonly element: Element }

export type OverlayKind = OverlayPresence['kind']

const present = new Set<OverlayPresence>()
const listeners = new Set<() => void>()
let snapshot: readonly OverlayPresence[] = Object.freeze([])

function changed(): void {
  snapshot = Object.freeze([...present])
  for (const listener of [...listeners]) listener()
}

/** 登记一层浮层，返回注销函数（重复调用无害）。 */
export function registerOverlay(presence: OverlayPresence): () => void {
  present.add(presence)
  changed()
  let registered = true
  return () => {
    if (!registered) return
    registered = false
    present.delete(presence)
    changed()
  }
}

/** 在场浮层的快照：没有变化时是同一个数组（可直接喂给 useSyncExternalStore）。 */
export function overlaysOnScreen(): readonly OverlayPresence[] {
  return snapshot
}

export function subscribeOverlays(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function forwardRef<T>(ref: Ref<T> | undefined, element: T): () => void {
  if (ref === undefined || ref === null) return () => undefined
  if (typeof ref === 'function') {
    const cleanup = ref(element)
    return typeof cleanup === 'function' ? cleanup : () => ref(null)
  }
  ref.current = element
  return () => {
    ref.current = null
  }
}

/**
 * 给弹层元素的 ref：挂上即登记、拆下即注销，同时把元素转交给调用方自己的 ref（可省）。
 * 转交的 ref 要引用稳定（useRef 的对象或模块级函数），否则每次渲染都会注销再登记一次。
 */
export function useOverlayRef<T extends Element>(kind: OverlayKind, forward?: Ref<T>): RefCallback<T> {
  return useCallback(
    (element: T | null) => {
      if (element === null) return undefined
      const unforward = forwardRef(forward, element)
      const unregister = registerOverlay(kind === 'modal' ? { kind } : { kind, element })
      return () => {
        unregister()
        unforward()
      }
    },
    [forward, kind],
  )
}

/** 拿不到弹层元素的模态浮层（例如第三方灯箱自己建传送门）：active 期间算在场。 */
export function useModalOverlay(active: boolean): void {
  useEffect(() => (active ? registerOverlay({ kind: 'modal' }) : undefined), [active])
}
