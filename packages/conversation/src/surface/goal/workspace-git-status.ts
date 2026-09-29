/*
 * 状态面板 Git 区读的那一份事实。
 *
 * 定义在对话包里而不是宿主：面板是这里的组件，宿主（桌面应用）只负责把它自己的
 * 分支面与改动面填进来。缺席用 null / undefined 表达 —— 非 git 仓库、没装 git、
 * 还没读到，都是「这一区不画」，不是一个假的 0。
 */
export interface WorkspaceGitStatus {
  /** 当前检出的分支；HEAD 分离时为 null。 */
  readonly branch: string | null
  /** HEAD 分离时所在提交的短号；在分支上时为 null。 */
  readonly detachedAt: string | null
  /** 相对 HEAD 的新增行数；读不到是 null。 */
  readonly added: number | null
  /** 相对 HEAD 的删除行数；读不到是 null。 */
  readonly removed: number | null
  /** 有改动的文件数（更改行 hover 之外还用得上）。 */
  readonly dirtyFileCount: number
  /** 上游分支名；没有上游为 null。 */
  readonly upstream: string | null
  /** 领先/落后上游的提交数。 */
  readonly ahead: number
  readonly behind: number
  /** 本地分支名单，按最近提交排序。 */
  readonly branches: readonly string[]
  /** 有一次切换或创建还在路上。 */
  readonly busy: boolean
  /** 弹层每次打开时刷新快照。 */
  readonly onRefresh: () => void
}
