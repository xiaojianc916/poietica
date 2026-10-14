import { AppError, type Logger } from '@poietica/foundation'
import { reviewErrors } from '../contract'
import type {
  GithubCheck,
  GithubCheckState,
  GithubComment,
  GithubMergeMethod,
  GithubMergeStatus,
  GithubPullRequest,
  GithubPullState,
  GithubRepository,
  GithubReviewState,
} from '../contract/entities'
import { detectGh, type GhRunner, ghApiJson, ghGraphql, systemGhRunner } from './gh'

/*
 * GitHub 事实 → 契约实体。所有「GitHub 怎么说」的判断都收在这个文件里：UI 只认契约的名字，
 * 不该知道 CONFLICTING / mergeStateStatus / CheckRun 这些词。映射规则逐条写在下方，改动只会在这里。
 *
 * 每个方法都按 cwd（工作区目录）寻址：`gh repo view` 在那里面认 origin 远端，所以同一台机器上
 * 多个工作区各自指向自己的仓库，互不干扰。
 */

export interface GithubServiceDeps {
  readonly runner?: GhRunner
  readonly logger: Logger
}

export interface GithubService {
  availability(): Promise<{
    readonly available: boolean
    readonly reason: string | null
    readonly login: string | null
  }>
  repository(cwd: string): Promise<GithubRepository | null>
  pullRequests(
    cwd: string,
    includeClosed: boolean,
  ): Promise<{ repository: GithubRepository | null; pulls: readonly GithubPullRequest[] }>
  pullRequest(cwd: string, number: number): Promise<GithubPullRequest>
  comments(cwd: string, number: number): Promise<readonly GithubComment[]>
  comment(cwd: string, number: number, body: string): Promise<GithubComment>
  setDraft(cwd: string, number: number, draft: boolean): Promise<void>
  merge(cwd: string, number: number, method: GithubMergeMethod): Promise<void>
}

/* ── GitHub 的原始形状（只声明我们读的那几个字段） ───────────────────────────── */

interface RawAuthor {
  readonly login?: string | null
  readonly avatarUrl?: string | null
}

interface RawCheckNode {
  readonly __typename?: string
  readonly name?: string | null
  readonly conclusion?: string | null
  readonly status?: string | null
  readonly context?: string | null
  readonly state?: string | null
}

export interface RawPullNode {
  readonly number: number
  readonly title: string
  readonly state?: string
  readonly isDraft?: boolean
  readonly createdAt?: string
  readonly updatedAt?: string
  readonly mergedAt?: string | null
  readonly mergeable?: string | null
  readonly mergeStateStatus?: string | null
  readonly additions?: number
  readonly deletions?: number
  readonly changedFiles?: number
  readonly headRefName?: string
  readonly baseRefName?: string
  readonly url?: string
  readonly body?: string
  readonly author?: RawAuthor | null
  readonly reviewDecision?: string | null
  readonly comments?: { readonly totalCount?: number }
  readonly reviews?: { readonly totalCount?: number }
  readonly commits?: { readonly totalCount?: number }
  readonly labels?: { readonly nodes?: readonly { readonly name?: string }[] }
  readonly statusCheckRollup?: { readonly contexts?: { readonly nodes?: readonly RawCheckNode[] } } | null
}

const PULL_FIELDS = `
  number title state isDraft createdAt updatedAt mergedAt
  mergeable mergeStateStatus additions deletions changedFiles
  headRefName baseRefName url body
  author { login avatarUrl }
  reviewDecision
  comments { totalCount } reviews { totalCount } commits { totalCount }
  labels(first: 20) { nodes { name } }
  statusCheckRollup { contexts(first: 50) { nodes {
    __typename
    ... on CheckRun { name conclusion status }
    ... on StatusContext { context state }
  } } }
`

const LIST_QUERY = `query($owner: String!, $name: String!, $states: [PullRequestState!]) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, states: $states, orderBy: {field: UPDATED_AT, direction: DESC}) {
      nodes { ${PULL_FIELDS} }
    }
  }
}`

const ONE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) { ${PULL_FIELDS} }
  }
}`

/* ── 映射 ──────────────────────────────────────────────────────────────────── */

/*
 * 合并可行性：GitHub 给两个字段，谁更具体用谁。
 * mergeable=CONFLICTING 最硬（有冲突），其次 isDraft，再按 mergeStateStatus 分档。
 */
export function mergeStatusOf(node: RawPullNode): GithubMergeStatus {
  if (node.isDraft === true) return 'draft'
  if (node.mergeable === 'CONFLICTING') return 'conflicting'
  switch (node.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return 'clean'
    case 'BLOCKED':
      return 'blocked'
    case 'BEHIND':
      return 'behind'
    case 'DIRTY':
      return 'conflicting'
    case 'DRAFT':
      return 'draft'
    default:
      return node.mergeable === 'MERGEABLE' ? 'clean' : 'unknown'
  }
}

/*
 * 检查项：两种节点形状合流。
 * CheckRun 没跑完时 conclusion 为 null → pending（GitHub 自己也是这么看的）。
 */
export function checkStateOf(node: RawCheckNode): GithubCheckState {
  if (node.__typename === 'StatusContext') {
    switch (node.state) {
      case 'SUCCESS':
        return 'success'
      case 'FAILURE':
      case 'ERROR':
        return 'failure'
      case 'PENDING':
        return 'pending'
      default:
        return 'neutral'
    }
  }
  switch (node.conclusion) {
    case 'SUCCESS':
      return 'success'
    case 'FAILURE':
    case 'TIMED_OUT':
    case 'CANCELLED':
    case 'ACTION_REQUIRED':
    case 'STARTUP_FAILURE':
      return 'failure'
    case 'SKIPPED':
      return 'skipped'
    case 'NEUTRAL':
      return 'neutral'
    default:
      return 'pending'
  }
}

function checksOf(node: RawPullNode): readonly GithubCheck[] {
  const nodes = node.statusCheckRollup?.contexts?.nodes ?? []
  return nodes.map((entry) => ({
    name: entry.name ?? entry.context ?? 'check',
    state: checkStateOf(entry),
  }))
}

function reviewStateOf(node: RawPullNode): GithubReviewState {
  switch (node.reviewDecision) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'REVIEW_REQUIRED':
      return 'review_required'
    default:
      return 'none'
  }
}

function pullStateOf(state: string | undefined): GithubPullState {
  switch (state) {
    case 'MERGED':
      return 'merged'
    case 'CLOSED':
      return 'closed'
    default:
      return 'open'
  }
}

/** 计数字段：GitHub 偶尔漏掉某个 totalCount，缺了就按 0 报，别让整页读不出来。 */
function countsOf(node: RawPullNode): {
  readonly additions: number
  readonly deletions: number
  readonly changedFiles: number
  readonly commits: number
  readonly comments: number
  readonly reviews: number
} {
  return {
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    changedFiles: node.changedFiles ?? 0,
    commits: node.commits?.totalCount ?? 0,
    comments: node.comments?.totalCount ?? 0,
    reviews: node.reviews?.totalCount ?? 0,
  }
}

function labelsOf(node: RawPullNode): readonly string[] {
  return (node.labels?.nodes ?? []).flatMap((label) =>
    label.name === undefined || label.name === '' ? [] : [label.name],
  )
}

export function toPull(node: RawPullNode): GithubPullRequest {
  return {
    number: node.number,
    title: node.title,
    state: pullStateOf(node.state),
    draft: node.isDraft === true,
    author: node.author?.login ?? 'ghost',
    avatarUrl: node.author?.avatarUrl ?? null,
    createdAt: node.createdAt ?? '',
    updatedAt: node.updatedAt ?? '',
    mergedAt: node.mergedAt ?? null,
    headBranch: node.headRefName ?? '',
    baseBranch: node.baseRefName ?? '',
    mergeStatus: mergeStatusOf(node),
    reviewState: reviewStateOf(node),
    url: node.url ?? '',
    body: node.body ?? '',
    labels: [...labelsOf(node)],
    checks: [...checksOf(node)],
    ...countsOf(node),
  }
}

/* ── REST 侧的评论形状 ─────────────────────────────────────────────────────── */

interface RawComment {
  readonly id?: number | string
  readonly user?: RawAuthor | null
  readonly body?: string
  readonly created_at?: string
  readonly submitted_at?: string
  readonly state?: string
}

function reviewStateFromRest(state: string | undefined): GithubReviewState {
  switch (state) {
    case 'APPROVED':
      return 'approved'
    case 'CHANGES_REQUESTED':
      return 'changes_requested'
    case 'COMMENTED':
      return 'none'
    default:
      return 'none'
  }
}

function toComment(raw: RawComment, kind: 'comment' | 'review'): GithubComment {
  return {
    id: String(raw.id ?? ''),
    kind,
    author: raw.user?.login ?? 'ghost',
    avatarUrl: raw.user?.avatarUrl ?? null,
    body: raw.body ?? '',
    createdAt: raw.created_at ?? raw.submitted_at ?? '',
    reviewState: kind === 'review' ? reviewStateFromRest(raw.state) : null,
  }
}

/* 评论与评审合成一条时间线：按时间升序，读的人从上往下就是事情发生的顺序。 */
function mergeTimeline(
  comments: readonly GithubComment[],
  reviews: readonly GithubComment[],
): readonly GithubComment[] {
  return [...comments, ...reviews].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
}

export function createGithubService(d: GithubServiceDeps): GithubService {
  const runner = d.runner ?? systemGhRunner

  /*
   * 每次都现问一次 gh repo view：工作区的远端是随时会被人改的东西（换了 origin、目录换了仓库），
   * 而这里没有可靠的失效时机 —— 缓存的代价是「换过远端之后这一页一直读旧仓库」。一次进程往返换一份
   * 不会说谎的事实，划算。
   */
  const repositoryOf = async (cwd: string): Promise<GithubRepository | null> => {
    const result = await runner(['repo', 'view', '--json', 'nameWithOwner,url'], { cwd })
    if (result.exitCode !== 0) {
      /* 远端不是 GitHub、目录不是仓库、gh 读不到 —— 都是「这里没有 GitHub 仓库」，不是错误。 */
      d.logger.debug('repository is not on GitHub', { cwd, stderr: result.stderr.trim().slice(0, 200) })
      return null
    }
    let parsed: { readonly nameWithOwner?: string; readonly url?: string }
    try {
      parsed = JSON.parse(result.stdout) as typeof parsed
    } catch {
      return null
    }
    const fullName = parsed.nameWithOwner ?? ''
    const [owner = '', name = ''] = fullName.split('/')
    if (owner === '' || name === '') {
      return null
    }
    return { owner, name, fullName, url: parsed.url ?? `https://github.com/${fullName}` }
  }

  const requireRepository = async (cwd: string, number: number): Promise<GithubRepository> => {
    const repository = await repositoryOf(cwd)
    if (repository === null) {
      throw new AppError(reviewErrors.github_unavailable, '这个工作区的远端不在 GitHub 上', { number })
    }
    return repository
  }

  return {
    async availability() {
      const found = await detectGh(runner)
      if (found.path === null) {
        return {
          available: false,
          reason: '没找到 gh：安装 GitHub CLI 并登录后，这一页会显示仓库的 pull request',
          login: null,
        }
      }
      if (found.login === null) {
        return { available: false, reason: 'gh 还没登录：运行 gh auth login 后回到这一页', login: null }
      }
      return { available: true, reason: null, login: found.login }
    },

    repository: (cwd) => repositoryOf(cwd),

    async pullRequests(cwd, includeClosed) {
      const repository = await repositoryOf(cwd)
      if (repository === null) {
        return { repository: null, pulls: [] }
      }
      const data = await ghGraphql<{
        readonly repository?: { readonly pullRequests?: { readonly nodes?: readonly RawPullNode[] } }
      }>(
        runner,
        LIST_QUERY,
        {
          owner: repository.owner,
          name: repository.name,
          states: includeClosed ? ['OPEN', 'CLOSED', 'MERGED'] : ['OPEN'],
        },
        { cwd },
      )
      const nodes = data.repository?.pullRequests?.nodes ?? []
      return { repository, pulls: nodes.map(toPull) }
    },

    async pullRequest(cwd, number) {
      const repository = await requireRepository(cwd, number)
      const data = await ghGraphql<{ readonly repository?: { readonly pullRequest?: RawPullNode | null } }>(
        runner,
        ONE_QUERY,
        { owner: repository.owner, name: repository.name, number },
        { cwd },
      )
      const node = data.repository?.pullRequest
      if (node === undefined || node === null) {
        throw new AppError(reviewErrors.pull_request_missing, `这个仓库里没有 #${String(number)}`, { number })
      }
      return toPull(node)
    },

    async comments(cwd, number) {
      const repository = await requireRepository(cwd, number)
      const base = `repos/${repository.owner}/${repository.name}`
      const [comments, reviews] = await Promise.all([
        ghApiJson<readonly RawComment[]>(runner, `${base}/issues/${String(number)}/comments?per_page=100`, { cwd }),
        ghApiJson<readonly RawComment[]>(runner, `${base}/pulls/${String(number)}/reviews?per_page=100`, { cwd }),
      ])
      return mergeTimeline(
        comments.map((raw) => toComment(raw, 'comment')),
        reviews.map((raw) => toComment(raw, 'review')),
      )
    },

    async comment(cwd, number, body) {
      const repository = await requireRepository(cwd, number)
      const result = await runner(['pr', 'comment', String(number), '--body-file', '-'], { cwd, input: body })
      if (result.exitCode !== 0) {
        throw new AppError(reviewErrors.github_failed, result.stderr.trim() || '评论没能发出去')
      }
      /* gh 不回评论对象；按「刚发的那一条就是最新一条评论」再读一次，比在本地拼更接近真相。 */
      const base = `repos/${repository.owner}/${repository.name}`
      const comments = await ghApiJson<readonly RawComment[]>(
        runner,
        `${base}/issues/${String(number)}/comments?per_page=100`,
        { cwd },
      )
      const mine = comments.at(-1)
      if (mine === undefined) {
        throw new AppError(reviewErrors.github_failed, '评论发出去了，但读不回来')
      }
      return toComment(mine, 'comment')
    },

    async setDraft(cwd, number, draft) {
      await requireRepository(cwd, number)
      /* gh 不带参数时按「转成可评审」理解；转草稿要显式给 --undo。 */
      const args = draft ? ['pr', 'ready', String(number), '--undo'] : ['pr', 'ready', String(number)]
      const result = await runner(args, { cwd })
      if (result.exitCode !== 0) {
        throw new AppError(reviewErrors.github_failed, result.stderr.trim() || '状态没能改过来')
      }
    },

    async merge(cwd, number, method) {
      await requireRepository(cwd, number)
      const flag = method === 'squash' ? '--squash' : method === 'rebase' ? '--rebase' : '--merge'
      /* 不删分支：那是用户的决定，不是「合并」这个词隐含的动作。 */
      const result = await runner(['pr', 'merge', String(number), flag], { cwd })
      if (result.exitCode !== 0) {
        throw new AppError(reviewErrors.merge_refused, result.stderr.trim() || 'GitHub 拒绝这次合并')
      }
    },
  }
}
