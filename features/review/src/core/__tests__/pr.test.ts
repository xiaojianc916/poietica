import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { createTestLogger } from '@poietica/test-kit'
import { createGithubClient, type GithubFetch } from '../github-http'
import { checkStateOf, createGithubService, mergeStatusOf } from '../pr'

/*
 * GitHub 事实 → 契约实体的映射，以及失败语义。这一份不碰网络：每一次请求都由假 fetch 接住，
 * 断言的是「我们怎么读 GitHub」，而不是 GitHub 本身。
 */

const logger = createTestLogger()

interface Call {
  readonly method: string
  readonly url: string
  readonly body: unknown
}

type Route = (call: Call) => { readonly status?: number; readonly body?: unknown } | undefined

/** 假 fetch：按顺序问每条路由，第一条认领的说了算；没人认领就是 404。 */
function fakeFetch(routes: readonly Route[]): { fetch: GithubFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: GithubFetch = async (url, init) => {
    const call: Call = {
      method: init.method ?? 'GET',
      url,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
    }
    calls.push(call)
    for (const route of routes) {
      const hit = route(call)
      if (hit !== undefined) {
        return new Response(hit.body === undefined ? null : JSON.stringify(hit.body), { status: hit.status ?? 200 })
      }
    }
    return new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 })
  }
  return { fetch, calls }
}

const graphqlWhen =
  (fragment: string, body: unknown): Route =>
  (call) =>
    call.url.endsWith('/graphql') && JSON.stringify(call.body).includes(fragment) ? { body } : undefined

const restWhen =
  (method: string, fragment: string, body: unknown, status = 200): Route =>
  (call) =>
    call.method === method && call.url.includes(fragment) ? { body, status } : undefined

const REMOTES =
  'origin\tgit@github.com:xiaojianc916/poietica.git (fetch)\norigin\tgit@github.com:xiaojianc916/poietica.git (push)\n'

function serviceOf(routes: readonly Route[], remotes: string = REMOTES) {
  const fake = fakeFetch(routes)
  const client = createGithubClient({ fetch: fake.fetch, tokens: async () => 'tok' })
  return { service: createGithubService({ client, logger, remotes: async () => remotes }), calls: fake.calls }
}

function pullNode(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 3,
    title: 'refactor(plugins): give installed ledger one native owner',
    state: 'OPEN',
    isDraft: false,
    createdAt: '2026-08-26T15:38:20Z',
    updatedAt: '2026-09-08T16:07:58Z',
    mergedAt: null,
    mergeable: 'CONFLICTING',
    mergeStateStatus: 'DIRTY',
    additions: 553,
    deletions: 358,
    changedFiles: 6,
    headRefName: 'refactor/plugin-ledger-ownership',
    baseRefName: 'main',
    url: 'https://github.com/xiaojianc916/poietica/pull/3',
    body: 'Summary\n\nmove it',
    author: { login: 'xiaojianc916', avatarUrl: 'https://avatars.example/u/1' },
    reviewDecision: null,
    comments: { totalCount: 0 },
    reviews: { totalCount: 0 },
    commits: { totalCount: 4 },
    labels: { nodes: [{ name: 'refactor' }] },
    statusCheckRollup: {
      contexts: {
        nodes: [
          { __typename: 'CheckRun', name: 'Frontend', conclusion: 'SUCCESS', status: 'COMPLETED' },
          { __typename: 'CheckRun', name: 'Rust', conclusion: 'FAILURE', status: 'COMPLETED' },
          { __typename: 'CheckRun', name: 'Windows Desktop', conclusion: 'FAILURE', status: 'COMPLETED' },
        ],
      },
    },
    ...over,
  }
}

describe('合并可行性的映射', () => {
  const of = (over: Record<string, unknown>): string =>
    mergeStatusOf({ number: 1, title: 't', ...over } as Parameters<typeof mergeStatusOf>[0])

  test('冲突最硬：mergeable=CONFLICTING 就是 conflicting', () => {
    expect(of({ mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' })).toBe('conflicting')
  })

  test('草稿优先：草稿 PR 不说它能合', () => {
    expect(of({ isDraft: true, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })).toBe('draft')
  })

  test('按 mergeStateStatus 分档', () => {
    expect(of({ mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })).toBe('clean')
    expect(of({ mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' })).toBe('blocked')
    expect(of({ mergeable: 'MERGEABLE', mergeStateStatus: 'BEHIND' })).toBe('behind')
    expect(of({ mergeable: 'MERGEABLE', mergeStateStatus: 'DIRTY' })).toBe('conflicting')
  })

  test('读不出来时说 unknown，不猜', () => {
    expect(of({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })).toBe('unknown')
  })
})

describe('检查项状态的映射', () => {
  const of = (over: Record<string, unknown>): string =>
    checkStateOf(over as unknown as Parameters<typeof checkStateOf>[0])

  test('CheckRun：结论说了算，没结论就是在跑', () => {
    expect(of({ __typename: 'CheckRun', conclusion: 'SUCCESS' })).toBe('success')
    expect(of({ __typename: 'CheckRun', conclusion: 'FAILURE' })).toBe('failure')
    expect(of({ __typename: 'CheckRun', conclusion: 'TIMED_OUT' })).toBe('failure')
    expect(of({ __typename: 'CheckRun', conclusion: 'SKIPPED' })).toBe('skipped')
    expect(of({ __typename: 'CheckRun', conclusion: 'NEUTRAL' })).toBe('neutral')
    expect(of({ __typename: 'CheckRun', conclusion: null })).toBe('pending')
  })

  test('StatusContext 换一套词，读法一样', () => {
    expect(of({ __typename: 'StatusContext', state: 'SUCCESS' })).toBe('success')
    expect(of({ __typename: 'StatusContext', state: 'FAILURE' })).toBe('failure')
    expect(of({ __typename: 'StatusContext', state: 'ERROR' })).toBe('failure')
    expect(of({ __typename: 'StatusContext', state: 'PENDING' })).toBe('pending')
  })
})

describe('拉一条 pull request', () => {
  const one = (node: Record<string, unknown>) => ({ data: { repository: { pullRequest: node } } })

  test('字段逐个落位：状态、分支、计数、检查项、标签', async () => {
    const { service, calls } = serviceOf([graphqlWhen('pullRequest(number', one(pullNode()))])
    const pull = await service.pullRequest('D:\\ws', 3)
    expect(pull.number).toBe(3)
    expect(pull.state).toBe('open')
    expect(pull.draft).toBe(false)
    expect(pull.author).toBe('xiaojianc916')
    expect(pull.headBranch).toBe('refactor/plugin-ledger-ownership')
    expect(pull.baseBranch).toBe('main')
    expect(pull.additions).toBe(553)
    expect(pull.deletions).toBe(358)
    expect(pull.changedFiles).toBe(6)
    expect(pull.commits).toBe(4)
    expect(pull.mergeStatus).toBe('conflicting')
    expect(pull.reviewState).toBe('none')
    expect(pull.labels).toEqual(['refactor'])
    expect(pull.checks.map((c) => c.name)).toEqual(['Frontend', 'Rust', 'Windows Desktop'])
    expect(pull.checks.map((c) => c.state)).toEqual(['success', 'failure', 'failure'])
    /* 仓库从本地远端认：整个过程只有这一次网络请求，变量与查询正文分开传 */
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toMatchObject({ variables: { owner: 'xiaojianc916', name: 'poietica', number: 3 } })
  })

  test('merged / closed 都认得出来', async () => {
    const { service } = serviceOf([
      graphqlWhen('pullRequest(number', one(pullNode({ state: 'MERGED', mergedAt: '2026-09-09T00:00:00Z' }))),
    ])
    expect((await service.pullRequest('D:\\ws', 3)).state).toBe('merged')
  })

  test('这一条不在 → pull_request_missing（不是通用失败）', async () => {
    const { service } = serviceOf([
      graphqlWhen('pullRequest(number', {
        data: { repository: { pullRequest: null } },
        errors: [{ message: 'Could not resolve to a PullRequest with the number of 9999.' }],
      }),
    ])
    const error = await service.pullRequest('D:\\ws', 9999).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('review.pull_request_missing')
  })

  test('远端不在 GitHub 上 → github_unavailable，而且不发网络请求', async () => {
    const { service, calls } = serviceOf([], 'origin\thttps://gitlab.com/a/b.git (fetch)\n')
    const error = await service.pullRequest('D:\\ws', 3).catch((e: unknown) => e)
    expect((error as AppError).code).toBe('review.github_unavailable')
    expect(calls).toHaveLength(0)
  })

  test('列清单：null 仓库时交回空清单，不抛', async () => {
    const { service } = serviceOf([], '')
    expect(await service.pullRequests('D:\\ws', false)).toEqual({ repository: null, pulls: [] })
  })

  test('列清单：一次 GraphQL 拿全，状态按 includeClosed 传', async () => {
    const { service, calls } = serviceOf([
      graphqlWhen('pullRequests(first', { data: { repository: { pullRequests: { nodes: [pullNode()] } } } }),
    ])
    const page = await service.pullRequests('D:\\ws', true)
    expect(page.repository?.fullName).toBe('xiaojianc916/poietica')
    expect(page.pulls.map((pull) => pull.number)).toEqual([3])
    expect(calls[0]?.body).toMatchObject({ variables: { states: ['OPEN', 'CLOSED', 'MERGED'] } })
  })

  test('列清单只取列表行的字段：不带正文、检查项、合并状态细档，那些留给打开时的单条查询', async () => {
    const { service, calls } = serviceOf([
      graphqlWhen('pullRequests(first', { data: { repository: { pullRequests: { nodes: [pullNode()] } } } }),
      graphqlWhen('pullRequest(number', { data: { repository: { pullRequest: pullNode() } } }),
    ])
    const page = await service.pullRequests('D:\\ws', true)
    const listQuery = String((calls[0]?.body as { query?: string } | undefined)?.query)
    for (const heavy of ['body', 'statusCheckRollup', 'mergeStateStatus', 'labels', 'reviewDecision', 'totalCount']) {
      expect(listQuery).not.toContain(heavy)
    }
    expect(Object.keys(page.pulls[0] ?? {})).not.toContain('body')
    /* 列表行仍认得出冲突（只靠 mergeable） */
    expect(page.pulls[0]?.mergeStatus).toBe('conflicting')

    const one = await service.pullRequest('D:\\ws', 3)
    const oneQuery = String((calls[1]?.body as { query?: string } | undefined)?.query)
    expect(oneQuery).toContain('statusCheckRollup')
    expect(oneQuery).toContain('mergeStateStatus')
    expect(one.body).toBe('Summary\n\nmove it')
    expect(one.checks).toHaveLength(3)
  })
})

describe('可用性', () => {
  test('有凭据：问一次 /user，之后记住登录名', async () => {
    const { service, calls } = serviceOf([restWhen('GET', '/user', { login: 'xiaojianc916' })])
    expect(await service.availability()).toEqual({ available: true, reason: null, login: 'xiaojianc916' })
    expect(await service.availability()).toEqual({ available: true, reason: null, login: 'xiaojianc916' })
    expect(calls.filter((call) => call.url.endsWith('/user'))).toHaveLength(1)
  })

  test('没凭据：不可用并说清怎么办，不抛', async () => {
    const fake = fakeFetch([])
    const client = createGithubClient({ fetch: fake.fetch, tokens: async () => null })
    const service = createGithubService({ client, logger, remotes: async () => REMOTES })
    const result = await service.availability()
    expect(result.available).toBe(false)
    expect(result.reason).toContain('gh auth login')
    expect(fake.calls).toHaveLength(0)
  })
})

describe('评论与写操作', () => {
  const comments = [
    {
      id: 11,
      user: { login: 'a', avatar_url: 'https://avatars.example/a' },
      body: 'first',
      created_at: '2026-09-01T00:00:00Z',
    },
  ]
  const reviews = [{ id: 21, user: { login: 'b' }, body: '', submitted_at: '2026-09-02T00:00:00Z', state: 'APPROVED' }]

  test('评论与评审合成一条时间线，按时间升序；REST 的头像字段读得到', async () => {
    const { service } = serviceOf([
      restWhen('GET', '/issues/3/comments', comments),
      restWhen('GET', '/pulls/3/reviews', reviews),
    ])
    const timeline = await service.comments('D:\\ws', 3)
    expect(timeline.map((c) => c.author)).toEqual(['a', 'b'])
    expect(timeline[0]?.avatarUrl).toBe('https://avatars.example/a')
    expect(timeline[1]?.kind).toBe('review')
    expect(timeline[1]?.reviewState).toBe('approved')
    expect(timeline[0]?.reviewState).toBeNull()
  })

  test('发评论：POST 正文，直接用 GitHub 回的那条', async () => {
    const { service, calls } = serviceOf([
      restWhen('POST', '/issues/3/comments', {
        id: 99,
        user: { login: 'me' },
        body: '看起来对',
        created_at: '2026-09-03T00:00:00Z',
      }),
    ])
    const posted = await service.comment('D:\\ws', 3, '看起来对')
    expect(posted.author).toBe('me')
    expect(posted.id).toBe('99')
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toEqual({ body: '看起来对' })
  })

  test('合并：三种方法各发各的 merge_method，且不删分支', async () => {
    for (const method of ['merge', 'squash', 'rebase'] as const) {
      const { service, calls } = serviceOf([restWhen('PUT', '/pulls/3/merge', { merged: true })])
      await service.merge('D:\\ws', 3, method)
      expect(calls).toHaveLength(1)
      expect(calls[0]?.body).toEqual({ merge_method: method })
      expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
    }
  })

  test('GitHub 拒绝合并 → merge_refused，带上它自己那句话', async () => {
    const { service } = serviceOf([
      restWhen('PUT', '/pulls/3/merge', { message: 'Pull Request is not mergeable' }, 405),
    ])
    const error = await service.merge('D:\\ws', 3, 'merge').catch((e: unknown) => e)
    expect((error as AppError).code).toBe('review.merge_refused')
    expect((error as AppError).message).toBe('Pull Request is not mergeable')
  })

  test('转草稿 / 可评审：先取节点 id，再发对应的 mutation', async () => {
    const { service, calls } = serviceOf([
      graphqlWhen('pullRequest(number: $number) { id }', { data: { repository: { pullRequest: { id: 'PR_1' } } } }),
      graphqlWhen('convertPullRequestToDraft', { data: { convertPullRequestToDraft: { clientMutationId: null } } }),
      graphqlWhen('markPullRequestReadyForReview', {
        data: { markPullRequestReadyForReview: { clientMutationId: null } },
      }),
    ])
    await service.setDraft('D:\\ws', 3, true)
    await service.setDraft('D:\\ws', 3, false)
    const mutations = calls.map((call) => JSON.stringify(call.body)).filter((body) => body.includes('mutation'))
    expect(mutations[0]).toContain('convertPullRequestToDraft')
    expect(mutations[1]).toContain('markPullRequestReadyForReview')
    expect(mutations[0]).toContain('"id":"PR_1"')
  })
})
