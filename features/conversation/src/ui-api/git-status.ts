import { defineContributionPoint } from '@poietica/ui-kernel'
import { type ComponentType, createContext, type ReactNode, useContext } from 'react'
import type { GitBranchPickerProps } from './git-branch-picker'

/*
 * 状态面板「Git 工具」那一格读的那一份事实，以及「谁来提供它」。
 *
 * 定义在对话包的 ui-api 而不是 ui：这一格有两个主人 —— 面板住在 conversation
 * （它画的是任务浮层的排版），事实属于 review（它认识 git）。两个功能之间只能经
 * contract / core-api / ui-api 协作（守则 3），所以形状与投递口都住在这一格，
 * review 往这里贡献一个 Provider，conversation 只把贡献套在树上。
 *
 * 缺席用 null / undefined 表达 —— 非 git 仓库、没装 git、还没读到，都是「这一区不画」，
 * 不是一个假的 0。**干净仓库是在场的**：它只是没有增删，照样画 +0 -0。
 */
export interface WorkspaceGitStatus {
  /** 当前检出的分支；HEAD 分离时为 null。 */
  readonly branch: string | null
  /** HEAD 分离时所在提交的短号；在分支上时为 null。 */
  readonly detachedAt: string | null
  /**
   * 相对 HEAD 的新增 / 删除行数。
   *
   * **不是可空的**：这一份事实只在「仓库读到了」时才存在（见 WorkspaceGitFacts 的闸门），
   * 所以干净仓库就是 0 —— 那两个数要么是事实，要么整份事实都不在。原先写成可空，
   * 于是「不知道」与「没改」在屏幕上长得一样（都是 +0 -0），产品负责人 2026-10-07
   * 点出的正是这一处。
   */
  readonly added: number
  readonly removed: number
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

/**
 * 面板那一格要的整副事实：正文那两行读 status，分支那一行读 picker。
 *
 * 两者同出一份快照（见 review 的 workspace-git-source）：分支与改动数是同一次读到的，
 * 不会出现「分支已经切了、数字还是上一个分支的」。
 */
export interface WorkspaceGitFacts {
  readonly status: WorkspaceGitStatus
  /** 分支名单读不到时缺席：那一行退成只读的分支名（不画切换入口）。 */
  readonly picker?: GitBranchPickerProps | undefined
}

/**
 * 当前工作区的 git 事实。**没有 Provider 时是 null**，不是抛错：
 * 单测夹具、没装 review 功能的宿主都拿得到「这一格不存在」这个合法答案。
 */
export const workspaceGitContext = createContext<WorkspaceGitFacts | null>(null)

export function useWorkspaceGitFacts(): WorkspaceGitFacts | null {
  return useContext(workspaceGitContext)
}

/** 提供者：谁认识 git 谁来贡献（现在是 review）。与 composerProviders 同形。 */
export interface WorkspaceGitProviderItem {
  readonly id: string
  readonly order: number
  readonly component: ComponentType<{ readonly children: ReactNode }>
}
export const workspaceGitProviders = defineContributionPoint<WorkspaceGitProviderItem>(
  'conversation.workspaceGitProviders',
)
