/*
 * 行内自己滚的盒子。
 *
 * 一行里可以有自己的滚动容器（工具抽屉那一面就是）。原生 wheel 会冒泡，所以视口收到的
 * wheel 里有一部分本来是给那一面的 —— 照单全收，就会把「在卡片里翻输出」判成「人离开了
 * 末端」，末端跟随于是断掉，而人根本没动视口。
 *
 * 约定只有一条：凡是自己滚的盒子都戴 data-scrollable。边界判定只认这个标记，不去猜
 * overflow —— 猜要读计算样式，而那是每一笔 wheel 都要付的一次布局。
 */

/** 自己滚的盒子的标记。 */
const NESTED_SCROLLER = '[data-scrollable]'

/** 贴边容差。scrollTop 可以是小数，而另外两个量是整数。 */
const EDGE_EPSILON_PX = 1

/** 这一笔 wheel 该落在谁身上：视口，还是行内某个自己滚的盒子。 */
export function scrollTargetOf(viewport: HTMLElement, target: EventTarget | null): HTMLElement {
  if (!(target instanceof Element)) {
    return viewport
  }

  const nested = target.closest(NESTED_SCROLLER)

  return nested instanceof HTMLElement && nested !== viewport && viewport.contains(nested)
    ? nested
    : viewport
}

/**
 * 这个盒子在这一笔的方向上还能不能再滚。滚不动了，这一笔才该交给视口。
 *
 * 只看方向不看步长，所以不必理 deltaMode：行、页、像素三种单位的正负号是同一个意思。
 * deltaY 为 0 的那些（横向滚轮、纯横向触控板手势）不是纵向手势，一概不算。
 */
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
