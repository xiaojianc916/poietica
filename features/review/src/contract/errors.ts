import { defineErrors } from '@poietica/contract-kit'

export const reviewErrors = defineErrors('review', {
  git_not_found: '系统中找不到 git',
  not_a_repository: '不是 git 仓库',
  git_failed: 'git 命令执行失败',
  nothing_to_commit: '没有可以提交的内容',
  branch_exists: '分支已存在',
})
