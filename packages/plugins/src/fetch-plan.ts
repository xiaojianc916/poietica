import { assertUnreachable } from '@poietica/problem'
import type { GitHubSource, PluginInstallSource } from './install-source'

/*
 * 一个安装来源要怎么取到手。
 *
 * 这一层刻意与原生侧的 PluginFetch 同形：结构一致意味着调用点直接把计划递过去就能
 * 通过类型检查，原生改了标签名 typecheck 当场就红。这比写一个只做搬运的适配函数更
 * 能守住契约，也没有多出一层什么都不做的包装。
 *
 * 同形也包括可空的写法：specta 把 Option<String> 映射成 string | null，所以这里是
 * null 而不是 undefined。领域里那一份用 undefined，转换就发生在 planFetch 这一处 ——
 * 它的职责本来就是「领域 → 线上」。
 */

export interface DirectoryFetch {
  readonly kind: 'directory'
  readonly path: string
}

export interface ArchiveFetch {
  readonly kind: 'archive'
  readonly url: string
  /** 归档解开之后，插件根在里面的哪一层。 */
  readonly subdirectory: string | null
}

export type PluginFetchPlan = ArchiveFetch | DirectoryFetch

export interface PlannedFetch {
  readonly kind: 'planned'
  readonly plan: PluginFetchPlan
}

export interface UnplannableFetch {
  readonly kind: 'unplannable'
  readonly reason: string
}

export type FetchPlanning = PlannedFetch | UnplannableFetch

/*
 * GitHub 官方文档《Downloading source code archives》只给三种归档地址：分支走
 * /archive/refs/heads/<branch>.zip，标签走 /archive/refs/tags/<tag>.zip，提交走
 * /archive/<sha>.zip —— 三种都要求已经知道 ref 叫什么。
 *
 * 只给仓库地址时那个 ref 是「默认分支」，而默认分支的名字只能从 api.github.com 的
 * 仓库信息里读（actions/checkout 的 getDefaultBranch 就是这么做的）。上游 Kimi Code
 * 的网络面不含 api.github.com，所以这里不猜 main 再猜 master：猜两次会造出两条安装
 * 路径，而且猜错时装进来的是另一个仓库状态。说不出 ref 就说不出。
 */
export const DEFAULT_BRANCH_UNPLANNABLE =
  '这个 GitHub 地址没有指明分支、标签或提交。请补上一个，例如 /tree/main。'

/* ref 里的斜杠是路径的一部分（release/1.x、codeql-cli/v2.12.0），只编码每一段。 */
function refPath(ref: string): string {
  return ref.split('/').map(encodeURIComponent).join('/')
}

function githubArchiveUrl(source: GitHubSource): string | undefined {
  const owner = encodeURIComponent(source.owner)
  const repo = encodeURIComponent(source.repo)
  const archive = `https://github.com/${owner}/${repo}/archive`
  const { ref } = source

  switch (ref.kind) {
    case 'commit':
      return `${archive}/${refPath(ref.sha)}.zip`
    case 'default-branch':
      return undefined
    case 'release-tag':
      return `${archive}/refs/tags/${refPath(ref.tag)}.zip`
    case 'tree':
      return `${archive}/refs/heads/${refPath(ref.ref)}.zip`
    default:
      return assertUnreachable(ref)
  }
}

export function planFetch(source: PluginInstallSource): FetchPlanning {
  switch (source.kind) {
    case 'archive':
      return { kind: 'planned', plan: { kind: 'archive', url: source.url, subdirectory: null } }
    case 'directory':
      return { kind: 'planned', plan: { kind: 'directory', path: source.path } }
    case 'github': {
      const url = githubArchiveUrl(source)

      return url === undefined
        ? { kind: 'unplannable', reason: DEFAULT_BRANCH_UNPLANNABLE }
        : {
            kind: 'planned',
            plan: { kind: 'archive', url, subdirectory: source.subdirectory ?? null },
          }
    }
    default:
      return assertUnreachable(source)
  }
}
