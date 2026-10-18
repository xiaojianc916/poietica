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
import { createGithubClient, type GithubClient, pickGithubRemote } from './github-http'

/*
 * GitHub 事实 → 契约实体。所有「GitHub 怎么说」的判断都收在这个文件里：UI 只认契约的名字，
 * 不该知道 CONFLICTING / mergeStateStatus / CheckRun 这些词。映射规则逐条写在下方，改动只会在这里。
 *
 * 每个方法都按 cwd（工作区目录）寻址：在那里面读 git 远端认出 owner/name，所以同一台机器上
 * 多个工作区各自指向自己的仓库，互不干扰。请求走 github-http 的直连客户端（不再起 gh 子进程）。
 */

export interface GithubServiceDeps {
  /** 直连客户端；测试里换成带假 fetch 的那一个。 */
  readonly client?: GithubClient
  /** 在 cwd 里跑 `git remote -v`，交回原样输出；不是仓库 / 没有远端时交回空串。 */
  readonly remotes: (cwd: string) => Promise<string>
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
  /** GraphQL 的写法。 */
  readonly avatarUrl?: string | null
  /** REST 的写法。 */
  readonly avatar_url?: string | null
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
    avatarUrl: raw.user?.avatar_url ?? raw.user?.avatarUrl ?? null,
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

const NODE_ID_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { id } }
}`

const READY_MUTATION = `mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { clientMutationId } }`
const DRAFT_MUTATION = `mutation($id: ID!) { convertPullRequestToDraft(input: { pullRequestId: $id }) { clientMutationId } }`

/*
 * 远端认出来的仓库只记这么久：列表、详情、评论三路几乎同时来，各跑一次 git 是浪费；
 * 但工作区的远端随时会被人改（换了 origin、目录换了仓库），记久了这一页就会一直读旧仓库。
 */
const REPOSITORY_TTL_MS = 15_000

function statusOf(cause: unknown): number | null {
  if (!(cause instanceof AppError)) return null
  const data = cause.data as { readonly status?: unknown } | undefined
  return typeof data?.status === 'number' ? data.status : null
}

export function createGithubService(d: GithubServiceDeps): GithubService {
  const client = d.client ?? createGithubClient()
  const repositories = new Map<string, { readonly at: number; readonly value: Promise<GithubRepository | null> }>()
  /* 登录名按 token 记：同一份凭据的登录名不会变，换了凭据（重新登录）自然换一格。 */
  const logins = new Map<string, Promise<string | null>>()

  const repositoryOf = (cwd: string): Promise<GithubRepository | null> => {
    const hit = repositories.get(cwd)
    if (hit !== undefined && Date.now() - hit.at < REPOSITORY_TTL_MS) {
      return hit.value
    }
    const value = d
      .remotes(cwd)
      .catch(() => '')
      .then((output) => {
        const picked = pickGithubRemote(output)
        if (picked === null) {
          /* 远端不是 GitHub、目录不是仓库 —— 都是「这里没有 GitHub 仓库」，不是错误。 */
          d.logger.debug('repository is not on GitHub', { cwd })
          return null
        }
        const fullName = `${picked.owner}/${picked.name}`
        return { owner: picked.owner, name: picked.name, fullName, url: `https://github.com/${fullName}` }
      })
    repositories.set(cwd, { at: Date.now(), value })
    return value
  }

  const requireRepository = async (cwd: string, number: number): Promise<GithubRepository> => {
    const repository = await repositoryOf(cwd)
    if (repository === null) {
      throw new AppError(reviewErrors.github_unavailable, '这个工作区的远端不在 GitHub 上', { number })
    }
    return repository
  }

  const loginOf = (token: string): Promise<string | null> => {
    let login = logins.get(token)
    if (login === undefined) {
      login = client
        .rest<{ readonly login?: string }>('GET', '/user')
        .then((user) => (typeof user.login === 'string' && user.login !== '' ? user.login : null))
      /* 失败（断网、凭据失效）不记：下次进页面重新问。 */
      login.catch(() => logins.delete(token))
      logins.set(token, login)
    }
    return login
  }

  const pathOf = (repository: GithubRepository): string =>
    `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`

  return {
    async availability() {
      const token = await client.token()
      if (token === null) {
        return {
          available: false,
          reason:
            '没找到 GitHub 凭据：设置 GITHUB_TOKEN 环境变量，或运行 gh auth login（也认 Git 凭据管理器里登录过的 github.com）后回到这一页',
          login: null,
        }
      }
      try {
        const login = await loginOf(token)
        return login === null
          ? { available: false, reason: 'GitHub 没认出这份凭据：重新运行 gh auth login 后回到这一页', login: null }
          : { available: true, reason: null, login }
      } catch (cause) {
        if (cause instanceof AppError && String(cause.code).endsWith('github_unavailable')) {
          return { available: false, reason: cause.message, login: null }
        }
        throw cause
      }
    },

    repository: (cwd) => repositoryOf(cwd),

    async pullRequests(cwd, includeClosed) {
      const repository = await repositoryOf(cwd)
      if (repository === null) {
        return { repository: null, pulls: [] }
      }
      const data = await client.graphql<{
        readonly repository?: { readonly pullRequests?: { readonly nodes?: readonly RawPullNode[] } }
      }>(LIST_QUERY, {
        owner: repository.owner,
        name: repository.name,
        states: includeClosed ? ['OPEN', 'CLOSED', 'MERGED'] : ['OPEN'],
      })
      const nodes = data.repository?.pullRequests?.nodes ?? []
      return { repository, pulls: nodes.map(toPull) }
    },

    async pullRequest(cwd, number) {
      const repository = await requireRepository(cwd, number)
      const data = await client.graphql<{ readonly repository?: { readonly pullRequest?: RawPullNode | null } }>(
        ONE_QUERY,
        { owner: repository.owner, name: repository.name, number },
      )
      const node = data.repository?.pullRequest
      if (node === undefined || node === null) {
        throw new AppError(reviewErrors.pull_request_missing, `这个仓库里没有 #${String(number)}`, { number })
      }
      return toPull(node)
    },

    async comments(cwd, number) {
      const repository = await requireRepository(cwd, number)
      const base = pathOf(repository)
      const [comments, reviews] = await Promise.all([
        client.rest<readonly RawComment[]>('GET', `${base}/issues/${String(number)}/comments?per_page=100`),
        client.rest<readonly RawComment[]>('GET', `${base}/pulls/${String(number)}/reviews?per_page=100`),
      ])
      return mergeTimeline(
        comments.map((raw) => toComment(raw, 'comment')),
        reviews.map((raw) => toComment(raw, 'review')),
      )
    },

    async comment(cwd, number, body) {
      const repository = await requireRepository(cwd, number)
      /* REST 直接回刚建好的评论对象：不必再读一遍列表去猜「最后一条是不是我的」。 */
      const created = await client.rest<RawComment>('POST', `${pathOf(repository)}/issues/${String(number)}/comments`, {
        body,
      })
      return toComment(created, 'comment')
    },

    async setDraft(cwd, number, draft) {
      const repository = await requireRepository(cwd, number)
      /* 草稿 / 可评审只有 GraphQL 能改，且要的是节点 id 而不是编号。 */
      const data = await client.graphql<{
        readonly repository?: { readonly pullRequest?: { readonly id?: string } | null }
      }>(NODE_ID_QUERY, { owner: repository.owner, name: repository.name, number })
      const id = data.repository?.pullRequest?.id
      if (id === undefined) {
        throw new AppError(reviewErrors.pull_request_missing, `这个仓库里没有 #${String(number)}`, { number })
      }
      await client.graphql(draft ? DRAFT_MUTATION : READY_MUTATION, { id })
    },

    async merge(cwd, number, method) {
      const repository = await requireRepository(cwd, number)
      /* 不删分支：那是用户的决定，不是「合并」这个词隐含的动作。 */
      try {
        await client.rest('PUT', `${pathOf(repository)}/pulls/${String(number)}/merge`, { merge_method: method })
      } catch (cause) {
        const status = statusOf(cause)
        /* 405 不可合并、409 头提交变了、422 方法不被允许：都是 GitHub 拒绝，把它那句话原样交给用户。 */
        if (status === 405 || status === 409 || status === 422) {
          throw new AppError(reviewErrors.merge_refused, (cause as AppError).message || 'GitHub 拒绝这次合并')
        }
        throw cause
      }
    },
  }
}
