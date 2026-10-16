/*
 * 行内自己滚的盒子（工具抽屉那一面就是）。原生 wheel 会冒泡，视口收到的有一部分本来是给那一面的，照单全收就会把「在卡片里翻输出」判成「人离开了末端」，末端跟随断掉而人根本没动视口。
 *
 * 约定只有一条：自己滚的盒子都戴 data-scrollable。边界判定只认这个标记，不去猜 overflow —— 猜要读计算样式，而那是每一笔 wheel 都要付的一次布局。
 */

const NESTED_SCROLLER = '[data-scrollable]'

/** 贴边容差。scrollTop 可以是小数，而另外两个量是整数。 */
const EDGE_EPSILON_PX = 1

export function scrollTargetOf(viewport: HTMLElement, target: EventTarget | null): HTMLElement {
  if (!(target instanceof Element)) {
    return viewport
  }

  const nested = target.closest(NESTED_SCROLLER)

  return nested instanceof HTMLElement && nested !== viewport && viewport.contains(nested) ? nested : viewport
}

/** 滚不动了，这一笔才该交给视口。只看方向不看步长，所以不必理 deltaMode；deltaY 为 0 的不是纵向手势，一概不算。 */
export function scrolledToEdge(
  box: { readonly clientHeight: number; readonly scrollHeight: number; readonly scrollTop: number },
  delta: number,
): boolean {
  if (delta < 0) {
    return box.scrollTop <= 0
  }

  if (delta > 0) {
    return box.scrollTop >= box.scrollHeight - box.clientHeight - EDGE_EPSILON_PX
  }

  return false
}
