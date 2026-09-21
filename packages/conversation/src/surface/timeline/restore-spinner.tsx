import { POIETICA_MARK_PATH } from '@poietica/design-system'
import { type CSSProperties, useId } from 'react'
import './restore-spinner.css'

export interface RestoreSpinnerProps {
  /** 这一格正在把一条对话读出来，而且还没有任何一行可画。 */
  readonly active: boolean
  /**
   * 浮起来的输入区实测高度；标记居中的下边界就是它。
   *
   * null 只覆盖首帧：useDockClearance 在 useLayoutEffect 里发布首个尺寸，React 会在
   * 绘制前同步补一次渲染，所以这一档不会被画出来。按 0 兜底只是为了式子恒成立。
   */
  readonly dockClearance: number | null
}

/**
 * 空白正中的那一枚标记。
 *
 * 回放一条已有对话时，界面按最终形态预排版（data-started），而转录还是空的：
 * 开场白被塌掉，转录高度为零，于是滚动区里一个像素都没有。那段空白是刻意
 * 换来的——它买到的是"回放到达时没有状态翻转"——但它此前不带任何反馈。
 * 这个标记就是补上的那一句反馈，没有别的职责。
 *
 * 画的是产品自己的标记（design-system 的 PoieticaMark 几何），不是图标库里
 * 那个通用转圈：等的是「这个产品正在读出你自己的对话」，用别家的字形说不出来。
 *
 * 只有标记和它自己的闪光：没有文案，没有底板，没有骨架屏。骨架屏在这里是错的 ——
 * 回放出来的行高矮不一，假条会在真内容到达时换一次形。
 *
 * 它是浮层，不占文档流。外面已经按"必然有内容"排好了版，标记一旦参与布局，
 * 撤除时就会把内容顶一下，那正是 data-started 花力气避开的东西。
 *
 * 名字直接传给渲染出的 svg，不挂在外面那层。外层是 live region，负责"这里出现了
 * 新状态"；名字属于图形本身，因此仍然只有一个名字、一次播报。
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
           * 亮条自己那一横条的浓淡。
           *
           * 两端渐隐、中间一整段是满的 —— 不是从 0 到 1 再到 0 的一条三角。三角形
           * 只有正中一条线满亮，两侧都是半亮的水洗，扫过去几乎看不出来；平台才是
           * 一道看得见的亮条。两端留软边，硬切口会读成一块贴上去的矩形补丁。
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
            <rect
              className="restore-spinner__band"
              fill={`url(#${id}s)`}
              height="24"
              width="12"
              x="0"
              y="0"
            />
          </mask>
        </defs>

        <use className="restore-spinner__base" href={`#${id}g`} />
        <use className="restore-spinner__glint" href={`#${id}g`} mask={`url(#${id}m)`} />
      </svg>
    </div>
  )
}
