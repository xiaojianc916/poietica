import { defineErrors } from '@poietica/contract-kit'

export const workspacesErrors = defineErrors('workspaces', {
  not_found: '工作区不存在',
  not_a_directory: '所选路径不是文件夹',
  directory_missing: '工作区文件夹已不存在',
  isolation_unavailable: '当前版本没有装配隔离工作区',
  not_local: '只能从本地工作区创建隔离副本',
  not_isolated: '只有隔离工作区可以交付或丢弃',
  worktree_failed: '创建隔离工作区失败',
})
