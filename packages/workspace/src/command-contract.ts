interface UICommand {
  readonly id: string
  readonly label: string
  /**
   * 行尾那一小行灰字：说清楚「是哪一个」。
   *
   * 同名的会话可以有很多条，只有标题的话人分不出来；这里放它所属的工作区。
   * 它参与检索 —— 打项目名就能把那个项目下的会话捞出来。
   */
  readonly detail?: string
  readonly shortcut?: string
  readonly when?: string
  readonly category?: string
}

export interface RegisteredCommand extends UICommand {
  readonly execute: () => void | Promise<void>
}
