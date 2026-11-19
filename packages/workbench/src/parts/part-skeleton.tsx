import type { ReactNode } from 'react'

export interface PartSkeletonProps {
  /**
   * 不画那层灰块，只留格子自己的地色。
   *
   * 右坞的内容格铺着 `bg-background`（深色 #181818），灰块是 `--ui-muted` 40% 叠上去，
   * 兑出来正是 #212121 —— 首次打开懒加载的功能（审查、文件……）会先闪一下这个颜色。
   * 坞里的兜底传 `quiet`：这一瞬的底色与功能自己画的地色一致。
   */
  readonly quiet?: boolean
}

/** 懒加载贡献的兜底占位。外壳不认识任何功能，所以只画一枚中性的灰块，不猜「正在加载什么」。 */
export function PartSkeleton({ quiet = false }: PartSkeletonProps): ReactNode {
  return (
    <div
      aria-hidden="true"
      className="workbench__skeleton"
      data-quiet={quiet ? 'true' : undefined}
      data-workbench-part="skeleton"
    />
  )
}
