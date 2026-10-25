import { defineErrors } from '@poietica/contract-kit'

export const reviewErrors = defineErrors('review', {
  git_not_found: '系统中找不到 git',
  not_a_repository: '不是 git 仓库',
  git_failed: 'git 命令执行失败',
  nothing_to_commit: '没有可以提交的内容',
  branch_exists: '分支已存在',
  /* 代码审查页的 GitHub 侧：读不到、写失败、以及「这一条不存在」。 */
  github_unavailable: '读不到 GitHub：没装 gh，或还没登录',
  github_failed: 'GitHub 请求失败',
  pull_request_missing: '这个 pull request 已经不在了',
  merge_refused: 'GitHub 拒绝这次合并',
  no_composer: '当前页面没有可用的输入框',
  /* 撤销一轮的文件改动：这一轮没有可撤的账（或已经撤过）；以及「有文件在此期间被别人改过」。 */
  rewind_not_available: '这一轮没有可以撤销的改动',
  rewind_unsafe: '这些文件在此期间被改过，不能撤销',
  /* 右坞那一格 diff：点开的那一行不在这一轮的账里（多半是别的轮、或账已经清掉）。 */
  turn_file_missing: '这一轮没有改过这个文件',
})
