import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { createTestLogger } from '@poietica/test-kit'
import { type GhResult, type GhRunner, ghApiJson, ghGraphql } from '../gh'
import { checkStateOf, createGithubService, mergeStatusOf } from '../pr'

/*
 * GitHub 事实 → 契约实体的映射，以及失败语义。这一份不碰网络：gh 的每一次调用都由假 runner 接住，
 * 断言的是「我们怎么读 GitHub」，而不是 GitHub 本身。
 */

const logger = createTestLogger()

/** 按前缀匹配的假 runner：键是命令片段，值是 stdout / 退出码。 */
function fakeRunner(table: readonly { match: string; stdout?: string; exitCode?: number; stderr?: string }[]): {
  runner: GhRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const runner: GhRunner = async (args, options) => {
    calls.push([...args, options?.input === undefined ? '' : `<<${options.input}`])
    const key = args.join(' ')
    const hit = table.find((entry) => key.includes(entry.match))
    if (hit === undefined) {
      return { exitCode: 1, stdout: '', stderr: `no fixture for: ${key}` }
    }
    return { exitCode: hit.exitCode ?? 0, stdout: hit.stdout ?? '', stderr: hit.stderr ?? '' } satisfies GhResult
  }
  return { runner, calls }
}

const REPO_VIEW = JSON.stringify({
  nameWithOwner: 'xiaojianc916/poietica',
  url: 'https://github.com/xiaojianc916/poietica',
})

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
  function serviceOf(table: readonly { match: string; stdout?: string; exitCode?: number; stderr?: string }[]) {
    const fake = fakeRunner(table)
    return { service: createGithubService({ runner: fake.runner, logger }), calls: fake.calls }
  }

  const one = (node: Record<string, unknown>): string => JSON.stringify({ data: { repository: { pullRequest: node } } })

  test('字段逐个落位：状态、分支、计数、检查项、标签', async () => {
    const { service } = serviceOf([
      { match: 'repo view', stdout: REPO_VIEW },
      { match: 'graphql', stdout: one(pullNode()) },
    ])
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
  })

  test('merged / closed 都认得出来', async () => {
    const merged = serviceOf([
      { match: 'repo view', stdout: REPO_VIEW },
      { match: 'graphql', stdout: one(pullNode({ state: 'MERGED', mergedAt: '2026-09-09T00:00:00Z' })) },
    ])
    expect((await merged.service.pullRequest('D:\\ws', 3)).state).toBe('merged')
  })

  test('这一条不在 → pull_request_missing（不是通用失败）', async () => {
    const { service } = serviceOf([
      { match: 'repo view', stdout: REPO_VIEW },
      {
        match: 'graphql',
        stdout: JSON.stringify({
          errors: [{ message: 'Could not resolve to a PullRequest with the number of 9999.' }],
        }),
      },
    ])
    const error = await service.pullRequest('D:\\ws', 9999).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('review.pull_request_missing')
  })

  test('远端不在 GitHub 上 → github_unavailable，而不是崩', async () => {
    const { service } = serviceOf([{ match: 'repo view', exitCode: 1, stderr: 'not a git repository' }])
    const error = await service.pullRequest('D:\\ws', 3).catch((e: unknown) => e)
    expect((error as AppError).code).toBe('review.github_unavailable')
  })

  test('列清单：null 仓库时交回空清单，不抛', async () => {
    const { service } = serviceOf([{ match: 'repo view', exitCode: 1, stderr: 'no remote' }])
    expect(await service.pullRequests('D:\\ws', false)).toEqual({ repository: null, pulls: [] })
  })
})

describe('评论与写操作', () => {
  const comments = JSON.stringify([
    { id: 11, user: { login: 'a', avatarUrl: null }, body: 'first', created_at: '2026-09-01T00:00:00Z' },
  ])
  const reviews = JSON.stringify([
    { id: 21, user: { login: 'b' }, body: '', submitted_at: '2026-09-02T00:00:00Z', state: 'APPROVED' },
  ])

  test('评论与评审合成一条时间线，按时间升序', async () => {
    const fake = fakeRunner([
      { match: 'repo view', stdout: REPO_VIEW },
      { match: '/issues/3/comments', stdout: comments },
      { match: '/pulls/3/reviews', stdout: reviews },
    ])
    const service = createGithubService({ runner: fake.runner, logger })
    const timeline = await service.comments('D:\\ws', 3)
    expect(timeline.map((c) => c.author)).toEqual(['a', 'b'])
    expect(timeline[1]?.kind).toBe('review')
    expect(timeline[1]?.reviewState).toBe('approved')
    expect(timeline[0]?.reviewState).toBeNull()
  })

  test('发评论：正文走 stdin，随后把最新一条读回来', async () => {
    const fake = fakeRunner([
      { match: 'repo view', stdout: REPO_VIEW },
      { match: 'pr comment', stdout: '' },
      { match: '/issues/3/comments', stdout: comments },
    ])
    const service = createGithubService({ runner: fake.runner, logger })
    const posted = await service.comment('D:\\ws', 3, '看起来对')
    expect(posted.author).toBe('a')
    const write = fake.calls.find((call) => call.includes('comment'))
    expect(write).toContain('--body-file')
    expect(write?.at(-1)).toBe('<<看起来对')
  })

  test('合并：三种方法各发各的参数，且不删分支', async () => {
    for (const [method, flag] of [
      ['merge', '--merge'],
      ['squash', '--squash'],
      ['rebase', '--rebase'],
    ] as const) {
      const fake = fakeRunner([
        { match: 'repo view', stdout: REPO_VIEW },
        { match: 'pr merge', stdout: '' },
      ])
      await createGithubService({ runner: fake.runner, logger }).merge('D:\\ws', 3, method)
      const call = fake.calls.find((entry) => entry.includes('merge'))
      expect(call).toContain(flag)
      expect(call).not.toContain('--delete-branch')
    }
  })

  test('GitHub 拒绝合并 → merge_refused，带上它自己那句话', async () => {
    const fake = fakeRunner([
      { match: 'repo view', stdout: REPO_VIEW },
      { match: 'pr merge', exitCode: 1, stderr: 'Pull request is not mergeable' },
    ])
    const error = await createGithubService({ runner: fake.runner, logger })
      .merge('D:\\ws', 3, 'merge')
      .catch((e: unknown) => e)
    expect((error as AppError).code).toBe('review.merge_refused')
    expect((error as AppError).message).toBe('Pull request is not mergeable')
  })
})

describe('transport', () => {
  test('ghGraphql：数组变量展开成 key[]，数字走 -F', async () => {
    const fake = fakeRunner([{ match: 'graphql', stdout: JSON.stringify({ data: { ok: true } }) }])
    await ghGraphql(fake.runner, 'query{}', { owner: 'a', number: 3, states: ['OPEN', 'CLOSED'] })
    const call = fake.calls[0] ?? []
    expect(call).toContain('-F')
    expect(call).toContain('number=3')
    expect(call.join(' ')).toContain('states[]=OPEN')
    expect(call.join(' ')).toContain('states[]=CLOSED')
  })

  test('退出码非 0 → github_failed，第一行 stderr 当消息', async () => {
    const fake = fakeRunner([{ match: 'api', exitCode: 1, stderr: 'HTTP 404\nmore' }])
    const error = await ghApiJson(fake.runner, 'repos/a/b').catch((e: unknown) => e)
    expect((error as AppError).code).toBe('review.github_failed')
    expect((error as AppError).message).toBe('HTTP 404')
  })
})
