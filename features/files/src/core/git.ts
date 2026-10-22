import { createGit } from '@poietica/git'
import type { FilesGit } from './service'

/* git 只用来回答两件事：哪些被忽略、仓库里有哪些文件。不是仓库（128）、没装 git 都按「不知道」处理，树照样能看。 */

const NUL = '\u0000'

function split(stdout: string): string[] {
  return stdout.split(NUL).filter((item) => item !== '')
}

export function createFilesGit(onError: (what: string, cause: unknown) => void): FilesGit {
  return {
    async ignored(root, candidates) {
      if (candidates.length === 0) return new Set()
      try {
        const result = await createGit({ cwd: root }).run(['check-ignore', '--stdin', '-z'], {
          input: candidates.join(NUL),
          okExitCodes: [0, 1, 128],
          timeoutMs: 10_000,
        })
        return result.exitCode === 0 ? new Set(split(result.stdout)) : new Set()
      } catch (cause: unknown) {
        onError('check-ignore', cause)
        return new Set()
      }
    },
    async files(root) {
      try {
        const result = await createGit({ cwd: root }).run(
          ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
          {
            okExitCodes: [0, 128],
            timeoutMs: 20_000,
          },
        )
        if (result.exitCode !== 0) return null
        const files = split(result.stdout)
        /* 输出撞上 process-kit 的上限时最后一条是半截路径，丢掉它。 */
        if (result.stdoutTruncated) files.pop()
        return [...new Set(files)]
      } catch (cause: unknown) {
        onError('ls-files', cause)
        return null
      }
    },
  }
}
