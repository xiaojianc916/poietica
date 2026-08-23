import type { ReactNode } from 'react'

/**
 * 工作台的停靠位。
 *
 * 位置是有限且由布局决定的，因此是一个封闭联合而不是任意字符串键：
 * 新增一个位置必须同时给出它在栅格里的坐标，类型会强制这件事被想到。
 */
export type WorkspacePartId = 'chrome' | 'sidebar' | 'main' | 'browser'

export interface WorkspacePart {
  readonly content: ReactNode
  /**
   * 无障碍名称。
   *
   * 只有在这个 Part 不是标签面板时才需要（例如设置界面接管主区域）；
   * 工作台态由标签条通过 aria-labelledby 关联，给了名字反而是两份。
   */
  readonly label?: string | undefined
}

/**
 * 浏览器那一格。
 *
 * 它比别的格多一个事实：在不在场。浏览器归开着它的那条对话（布局意图里的
 * browserThread），而那条对话此刻是不是在屏幕上只有组合根知道 —— 停靠与
 * 原生 webview 的可见性因此读同一个布尔，不可能各说各话。
 */
export interface WorkspaceBrowserPart extends WorkspacePart {
  readonly isDocked: boolean
}

/**
 * Part 表。
 *
 * 每个停靠位都必须有内容：可选插槽在这张表里没有位置 —— 一个没有生产者的槽
 * 永远编译得过，而它的消费方要为一个不会出现的值一直留着分支。
 */
export type WorkspaceParts = Record<Exclude<WorkspacePartId, 'browser'>, WorkspacePart> & {
  readonly browser: WorkspaceBrowserPart
}
