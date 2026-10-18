import { describe, expect, test } from 'bun:test'
import type { AppError } from '@poietica/foundation'
import {
  type CommandRunner,
  createGithubClient,
  type GithubFetch,
  parseGithubRemote,
  passwordFromCredential,
  pickGithubRemote,
  systemTokenSource,
} from '../github-http'

/* 直连客户端的三件事：认远端、找凭据、HTTP 失败语义。不碰网络，不起真进程。 */

describe('认远端', () => {
  test('github.com 的三种写法都认得，.git 与末尾斜杠可有可无', () => {
    const expected = { owner: 'xiaojianc916', name: 'poietica' }
    expect(parseGithubRemote('https://github.com/xiaojianc916/poietica.git')).toEqual(expected)
    expect(parseGithubRemote('https://github.com/xiaojianc916/poietica/')).toEqual(expected)
    expect(parseGithubRemote('https://user:tok@github.com/xiaojianc916/poietica')).toEqual(expected)
    expect(parseGithubRemote('git@github.com:xiaojianc916/poietica.git')).toEqual(expected)
    expect(parseGithubRemote('ssh://git@github.com/xiaojianc916/poietica.git')).toEqual(expected)
  })

  test('别的主机不认', () => {
    expect(parseGithubRemote('https://gitlab.com/a/b.git')).toBeNull()
    expect(parseGithubRemote('git@github.example.com:a/b.git')).toBeNull()
    expect(parseGithubRemote('D:\\repos\\b')).toBeNull()
  })

  test('origin 优先，其次 upstream，再其次第一个 GitHub 远端', () => {
    const verbose = [
      'fork\thttps://github.com/me/poietica.git (fetch)',
      'upstream\thttps://github.com/up/poietica.git (fetch)',
      'origin\thttps://gitlab.com/x/y.git (fetch)',
    ].join('\n')
    expect(pickGithubRemote(verbose)).toEqual({ owner: 'up', name: 'poietica' })
    expect(pickGithubRemote(`${verbose}\norigin2\tgit@github.com:o/r.git (fetch)`)?.owner).toBe('up')
    expect(pickGithubRemote('fork\thttps://github.com/me/p.git (fetch)')).toEqual({ owner: 'me', name: 'p' })
    expect(pickGithubRemote('')).toBeNull()
  })
})

describe('找凭据', () => {
  const noCommands: CommandRunner = async () => null

  test('环境变量最先', async () => {
    const source = systemTokenSource({ env: { GITHUB_TOKEN: ' env-tok ' }, command: noCommands })
    expect(await source()).toBe('env-tok')
  })

  test('其次 gh auth token，再其次 git credential fill（不弹窗）', async () => {
    const asked: string[] = []
    const command: CommandRunner = async (name, args, options) => {
      asked.push(`${name} ${args.join(' ')}`)
      if (name === 'gh') return { exitCode: 1, stdout: '' }
      expect(options?.input).toContain('host=github.com')
      return { exitCode: 0, stdout: 'protocol=https\nhost=github.com\nusername=me\npassword=gcm-tok\n' }
    }
    expect(await systemTokenSource({ env: {}, command })()).toBe('gcm-tok')
    expect(asked).toEqual(['gh auth token --hostname github.com', 'git credential fill'])

    const gh: CommandRunner = async (name) => (name === 'gh' ? { exitCode: 0, stdout: 'gh-tok\n' } : null)
    expect(await systemTokenSource({ env: {}, command: gh })()).toBe('gh-tok')
  })

  test('哪里都没有 → null', async () => {
    expect(await systemTokenSource({ env: {}, command: noCommands })()).toBeNull()
    expect(passwordFromCredential('username=me\n')).toBeNull()
  })
})

describe('HTTP 失败语义', () => {
  const respond =
    (status: number, body: unknown, headers: Record<string, string> = {}): GithubFetch =>
    async () =>
      new Response(JSON.stringify(body), { status, headers })

  test('带上凭据与版本头；并发的第一次取凭据只跑一遍', async () => {
    let asked = 0
    const seen: Headers[] = []
    const client = createGithubClient({
      tokens: async () => {
        asked += 1
        return 'tok'
      },
      fetch: async (_url, init) => {
        seen.push(new Headers(init.headers))
        return new Response('{"login":"me"}')
      },
    })
    await Promise.all([client.rest('GET', '/user'), client.rest('GET', '/user'), client.rest('GET', '/user')])
    expect(asked).toBe(1)
    expect(seen[0]?.get('authorization')).toBe('Bearer tok')
    expect(seen[0]?.get('x-github-api-version')).toBe('2022-11-28')
  })

  test('401：丢掉缓存重取一次；再 401 才算凭据失效', async () => {
    const tokens = ['old', 'new']
    const used: string[] = []
    const client = createGithubClient({
      tokens: async () => tokens.shift() ?? 'new',
      fetch: async (_url, init) => {
        const auth = new Headers(init.headers).get('authorization') ?? ''
        used.push(auth)
        return auth === 'Bearer new' ? new Response('{"ok":true}') : new Response('{}', { status: 401 })
      },
    })
    expect(await client.rest('GET', '/user')).toEqual({ ok: true })
    expect(used).toEqual(['Bearer old', 'Bearer new'])

    const dead = createGithubClient({ tokens: async () => 'x', fetch: respond(401, { message: 'Bad credentials' }) })
    const error = (await dead.rest('GET', '/user').catch((e: unknown) => e)) as AppError
    expect(error.code).toBe('review.github_unavailable')
  })

  test('限流、非 2xx、断网各有各的话', async () => {
    const limited = createGithubClient({
      tokens: async () => 'x',
      fetch: respond(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0' }),
    })
    expect(((await limited.rest('GET', '/x').catch((e: unknown) => e)) as AppError).message).toContain('限额')

    const missing = createGithubClient({ tokens: async () => 'x', fetch: respond(404, { message: 'Not Found' }) })
    const notFound = (await missing.rest('GET', '/x').catch((e: unknown) => e)) as AppError
    expect(notFound.code).toBe('review.github_failed')
    expect(notFound.message).toBe('Not Found')
    expect(notFound.data?.status).toBe(404)

    const offline = createGithubClient({
      tokens: async () => 'x',
      fetch: async () => {
        throw new TypeError('fetch failed')
      },
    })
    expect(((await offline.rest('GET', '/x').catch((e: unknown) => e)) as AppError).message).toContain('连不上 GitHub')
  })

  test('没凭据：不发请求，直接 github_unavailable', async () => {
    let sent = 0
    const client = createGithubClient({
      tokens: async () => null,
      fetch: async () => {
        sent += 1
        return new Response('{}')
      },
    })
    const error = (await client.graphql('query{}', {}).catch((e: unknown) => e)) as AppError
    expect(error.code).toBe('review.github_unavailable')
    expect(sent).toBe(0)
  })
})
