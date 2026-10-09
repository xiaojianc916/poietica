import { POIETICA_MARK_PATH } from '@poietica/design-system'
import { type CSSProperties, useId } from 'react'
import './restore-spinner.css'

export interface RestoreSpinnerProps {
  /** 这一格正在把一条对话读出来，而且还没有任何一行可画。 */
  readonly active: boolean
  /**
   * 浮起来的输入区实测高度；标记居中的下边界就是它。
   *
   * null 只覆盖首帧（useLayoutEffect 发布首个尺寸后，React 绘制前会同步补一次渲染，
   * 这一档不会被画出来）；按 0 兜底只是让式子恒成立。
   */
  readonly dockClearance: number | null
}

/**
 * 空白正中的那一枚标记。
 *
 * 回放已有对话时界面按最终形态预排版（data-started），转录高度为零 —— 那段空白是
 * 刻意换来的（回放到达时没有状态翻转），这个标记是补上的反馈。画产品自己的标记
 * （design-system 的 PoieticaMark 几何），不用图标库的通用转圈。没有骨架屏：回放
 * 行高矮不一，假条会在真内容到达时换一次形。它是浮层不占文档流：参与布局会在
 * 撤除时把内容顶一下，那正是 data-started 要避开的。aria-label 直接放 svg 上：
 * 外层是 live region，各播报一次，只有一个名字。
 */
export function RestoreSpinner({ active, dockClearance }: RestoreSpinnerProps) {
  /* 每个实例一组自己的 id：mask 与渐变按 url(#id) 解析，重名会取到先落地的那个。 */
  const id = useId().replace(/[^a-z0-9]/gi, '')

  if (!active) {
    return null
  }

  return (
    <div
      className="restore-spinner"
      role="status"
      /*
       * 与滚动区末端留白读同一次实测、同一个名字：居中的下边界就是输入区的上沿，
       * 两处各量一次迟早分叉。--cp- 是组件局部派生量的命名空间，定义权随组件走。
       */
      style={{ '--cp-dock-clearance': `${String(dockClearance ?? 0)}px` } as CSSProperties}
    >
      <svg
        aria-label="正在载入对话"
        className="restore-spinner__mark"
        role="img"
        viewBox="0 0 24 24"
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          {/*
           * 字形只写一遍，两层各自 use 它 —— 两层必须是同一份几何，否则亮条扫过
           * 的位置与标记的边错开，看上去是两层图。
           */}
          <path d={POIETICA_MARK_PATH} fillRule="evenodd" id={`${id}g`} />

          {/*
           * 两端渐隐、中间满亮，不是三角：三角只有正中一条线满亮，扫不出来。两端
           * 留软边，硬切口会读成贴上去的矩形补丁。
           */}
          <linearGradient id={`${id}s`}>
            <stop offset="0" stopColor="#fff" stopOpacity="0" />
            <stop offset="0.25" stopColor="#fff" stopOpacity="1" />
            <stop offset="0.75" stopColor="#fff" stopOpacity="1" />
            <stop offset="1" stopColor="#fff" stopOpacity="0" />
          </linearGradient>

          {/*
           * 遮罩按用户坐标给满整个视口：默认的 objectBoundingBox 会把可扫范围裁到
           * 字形外接框上，两端那几格就扫不到了。
           */}
          <mask height="24" id={`${id}m`} maskUnits="userSpaceOnUse" width="24" x="0" y="0">
            <rect className="restore-spinner__band" fill={`url(#${id}s)`} height="24" width="12" x="0" y="0" />
          </mask>
        </defs>

        <use className="restore-spinner__base" href={`#${id}g`} />
        <use className="restore-spinner__glint" href={`#${id}g`} mask={`url(#${id}m)`} />
      </svg>
    </div>
  )
}
