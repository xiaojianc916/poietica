/** 系统中找不到 git（PATH 中没有 git.exe）。review 转换为 review.git_not_found */
export class GitNotFoundError extends Error {
  override readonly name = 'GitNotFoundError'
}

/** cwd 不是 git 仓库。review 转换为 review.not_a_repository（git.status 例外：返回 isRepo:false） */
export class NotARepositoryError extends Error {
  override readonly name = 'NotARepositoryError'
}

/** git 命令失败。stderr 最多保留 2000 字符。review 转换为 review.git_failed（data 带 stderr） */
export class GitCommandError extends Error {
  override readonly name = 'GitCommandError'
  constructor(
    readonly reason: 'exit' | 'timeout' | 'aborted',
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(
      `git ${args.join(' ')} 失败（${reason}${exitCode === null ? '' : `，退出码 ${exitCode}`}）：${stderr.slice(0, 300)}`,
    )
  }
}

/** 参数被拒绝（例如分支名以 - 开头，会被 git 当成选项）。在启动 git 之前抛出 */
export class GitRefusedError extends Error {
  override readonly name = 'GitRefusedError'
}
