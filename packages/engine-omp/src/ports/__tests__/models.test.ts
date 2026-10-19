import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { lookup } from '@oh-my-pi/pi-coding-agent/config/registry'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import type { Logger } from '@poietica/foundation'
import type { OmpModel } from '../../omp-context'
import { aliasOf, enabledMatcher, nextEnabledPatterns, stringArrayOf } from '../model-helpers'
import { migrateLegacyTitleRole, OmpModelsPort } from '../models'
import { CustomProvidersFile, modelsFilePath } from '../models-file'
import { ompRolesOf } from '../omp-ports'

const made: string[] = []
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'poietica-models-'))
  made.push(dir)
  return dir
}

const MODELS: readonly OmpModel[] = [
  {
    provider: 'anthropic',
    id: 'claude-opus-4-5',
    name: 'Opus',
    reasoning: true,
    contextWindow: 200000,
    input: ['text', 'image'],
  },
  { provider: 'openai', id: 'gpt-5', name: 'GPT-5', reasoning: true, contextWindow: 400000, input: ['text'] },
]

interface Harness {
  readonly port: OmpModelsPort
  readonly settings: Settings
  /** agent.db 里的凭据（API Key 与 OAuth 各占一行） */
  readonly credentials: Ledger
  /** omp 自己的鉴权判据（hasConfiguredAuth 的记账）——写 key、写 models.yml、免密钥端点都会让它为真 */
  readonly authorized: Set<string>
  readonly logged: string[]
  /** registry 重读的次数（models.yml 写完之后必须重读） */
  readonly reloads: number[]
  /** 登录之后只刷那一家（refreshProvider） */
  readonly refreshed: string[]
}

/** agent.db 凭据表的替身：按行记，每行一种（api_key / oauth） */
class Ledger {
  #rows: { id: number; provider: string; type: 'api_key' | 'oauth'; email: string | null }[] = []
  #next = 1
  add(provider: string, type: 'api_key' | 'oauth', email: string | null = null): void {
    this.#rows.push({ id: this.#next++, provider, type, email })
  }
  has(provider: string, type?: 'api_key' | 'oauth'): boolean {
    return this.#rows.some((row) => row.provider === provider && (type === undefined || row.type === type))
  }
  email(provider: string): string | null {
    return this.#rows.find((row) => row.provider === provider && row.type === 'oauth')?.email ?? null
  }
  list(provider: string): { id: number; credential: { type: string } }[] {
    return this.#rows
      .filter((row) => row.provider === provider)
      .map((row) => ({ id: row.id, credential: { type: row.type } }))
  }
  remove(provider: string, id: number): boolean {
    const before = this.#rows.length
    this.#rows = this.#rows.filter((row) => !(row.provider === provider && row.id === id))
    return this.#rows.length !== before
  }
  drop(provider: string, type: 'api_key' | 'oauth'): void {
    this.#rows = this.#rows.filter((row) => !(row.provider === provider && row.type === type))
  }
}

function makePort(): Harness {
  const dir = tempDir()
  const settings = Settings.isolated()
  /* anthropic 两样都有：一把 API Key，外加一份账号登录 —— 删一样不能连带另一样 */
  const credentials = new Ledger()
  credentials.add('anthropic', 'api_key')
  credentials.add('anthropic', 'oauth', 'pro@example.com')
  const authorized = new Set<string>(['anthropic'])
  const logged: string[] = []
  const logger: Logger = {
    debug: () => undefined,
    info: (message, data) => logged.push(`${message} ${JSON.stringify(data ?? null)}`),
    warn: (message, data) => logged.push(`${message} ${JSON.stringify(data ?? null)}`),
    error: () => undefined,
    child: () => logger,
  }
  const reloads: number[] = []
  const refreshed: string[] = []
  const noteReload = (): void => {
    reloads.push(reloads.length)
  }
  const port = new OmpModelsPort({
    registry: {
      all: () => MODELS,
      available: () => MODELS,
      find: (provider, id) => MODELS.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: (model) => authorized.has(model.provider),
      hydrateCredentialScopedModelCaches: () => Promise.resolve(),
      refreshInBackground: () => undefined,
      refreshProvider: (provider) => {
        refreshed.push(provider)
        return Promise.resolve()
      },
    },
    oauth: {
      providers: () => [
        { id: 'anthropic', name: 'Claude Pro/Max', available: true, kind: 'account' },
        {
          id: 'openai-codex-device',
          name: 'ChatGPT（设备码）',
          available: true,
          storeCredentialsAs: 'openai-codex',
          kind: 'account',
        },
        { id: 'openrouter', name: 'OpenRouter', available: true, kind: 'browser-key' },
        { id: 'deepseek', name: 'DeepSeek', available: true, kind: 'manual-key' },
      ],
      authenticated: (provider) => credentials.has(provider, 'oauth'),
      account: (provider) => credentials.email(provider),
      logout: async (provider) => {
        credentials.drop(provider, 'oauth')
      },
      login: async (providerId, ctrl) => {
        ctrl.onAuth({
          url: `https://auth.example/${providerId}`,
          launchUrl: 'http://127.0.0.1:1455/go',
          instructions: 'Enter code: ABCD-1234',
        })
        ctrl.onProgress('Waiting for browser authentication...')
        ctrl.onProgress('Some brand-new omp phrase')
        const code = await ctrl.onPrompt({
          message: 'Paste the authorization code (or full redirect URL):',
          secret: true,
        })
        credentials.add(
          providerId === 'openai-codex-device' ? 'openai-codex' : providerId,
          'oauth',
          `${code}@example.com`,
        )
        return { type: 'oauth', email: `${code}@example.com` }
      },
    },
    /* 角色目录用 omp 真身（config/model-roles），只把注册表换成两条模型 */
    roles: ompRolesOf(settings, { getAvailable: () => MODELS }),
    credentials: {
      has: (provider) => credentials.has(provider),
      set: (provider) => {
        credentials.add(provider, 'api_key')
        authorized.add(provider)
        return Promise.resolve()
      },
      list: (provider) => credentials.list(provider),
      removeById: (provider, id) => Promise.resolve(credentials.remove(provider, id)),
    },
    root: settings,
    customProviders: new CustomProvidersFile({
      file: modelsFilePath(dir),
      logger,
      /* 写完 models.yml 让 registry 重新读取 —— 与端口自己的 reload 是同一件事 */
      reload: noteReload,
    }),
    logger,
    reload: () => {
      reloads.push(reloads.length)
      return Promise.resolve()
    },
  })
  return { port, settings, credentials, authorized, logged, reloads, refreshed }
}

describe('ModelsPort 账号登录', () => {
  test('loginProviders 只报账号授权与浏览器换钥匙两类，凭据记在 storeCredentialsAs 名下，带上登录的账号', async () => {
    const harness = makePort()
    expect(await harness.port.loginProviders()).toEqual([
      {
        id: 'anthropic',
        name: 'Claude Pro/Max',
        provider: 'anthropic',
        available: true,
        authenticated: true,
        account: 'pro@example.com',
        issuesApiKey: false,
      },
      {
        id: 'openai-codex-device',
        name: 'ChatGPT（设备码）',
        provider: 'openai-codex',
        available: true,
        authenticated: false,
        account: null,
        issuesApiKey: false,
      },
      {
        id: 'openrouter',
        name: 'OpenRouter',
        provider: 'openrouter',
        available: true,
        authenticated: false,
        account: null,
        issuesApiKey: true,
      },
    ])
  })

  test('login 把网址、设备码与要填的格子交给宿主：认得的话换成中文，认不得的进度不转发', async () => {
    const harness = makePort()
    const seen: string[] = []
    const identity = await harness.port.login('openai-codex-device', {
      onAuth: (info) => seen.push(`auth ${info.url} ${info.launchUrl} code=${info.code} ${info.instructions}`),
      onProgress: (message) => seen.push(`progress ${message}`),
      onPrompt: async (prompt) => {
        seen.push(`prompt ${prompt.message} secret=${prompt.secret} fallback=${prompt.fallback}`)
        return 'me'
      },
      signal: new AbortController().signal,
    })
    expect(seen).toEqual([
      'auth https://auth.example/openai-codex-device http://127.0.0.1:1455/go code=ABCD-1234 null',
      'progress 等待在浏览器中完成授权…',
      'prompt 粘贴授权码或完整的回调地址 secret=true fallback=true',
    ])
    expect(identity).toEqual({ kind: 'oauth', email: 'me@example.com', orgName: null })
    expect(harness.refreshed).toEqual(['openai-codex'])
    expect(harness.credentials.has('openai-codex', 'oauth')).toBe(true)
  })

  test('logout 只删 OAuth 那一行，API Key 留着；没登录时什么也不做', async () => {
    const harness = makePort()
    let fired = 0
    const sub = harness.port.onDidChange(() => {
      fired += 1
    })
    await harness.port.logout('anthropic')
    expect(harness.credentials.has('anthropic', 'oauth')).toBe(false)
    expect(harness.credentials.has('anthropic', 'api_key')).toBe(true)
    expect(harness.refreshed).toEqual(['anthropic'])
    expect(fired).toBe(1)
    await harness.port.logout('openai')
    expect(fired).toBe(1)
    sub.dispose()
  })

  test('不在 omp 名单里的登录报 invalid_params，不去碰凭据', async () => {
    const harness = makePort()
    const io = {
      onAuth: () => undefined,
      onProgress: () => undefined,
      onPrompt: async () => '',
      signal: new AbortController().signal,
    }
    await expect(harness.port.login('nope', io)).rejects.toMatchObject({ code: 'kernel.invalid_params' })
  })
})

describe('ModelsPort', () => {
  test('providers 列出 registry 认得的全部 provider，custom 来自 models.yml', async () => {
    const harness = makePort()
    const providers = await harness.port.providers()
    expect(providers.map((p) => [p.id, p.custom])).toEqual([
      ['anthropic', false],
      ['openai', false],
    ])
    expect(providers.every((p) => p.authKind === 'api_key' && p.docsUrl === null)).toBe(true)
  })

  /*
   * omp 知识 #18：configured 用 omp 自己的鉴权判据（hasConfiguredAuth），不是凭据表。
   * models.yml 里写死 key 的服务商、auth: none 的免密钥端点都算「已配置」；只看
   * credentials.has 会在真机上把它们误报成没配，入口页于是挂出「还没有配置任何模型服务商」。
   */
  test('providers 的 configured 跟 omp 的鉴权判据，不由凭据表说了算', async () => {
    const harness = makePort()
    expect((await harness.port.providers()).map((p) => [p.id, p.configured])).toEqual([
      ['anthropic', true],
      ['openai', false],
    ])
    /* 只把 openai 记进 omp 的判据：凭据表里没有它 —— 这正是 models.yml 里写死 key 的那种服务商 */
    harness.authorized.add('openai')
    expect((await harness.port.providers()).map((p) => [p.id, p.configured])).toEqual([
      ['anthropic', true],
      ['openai', true],
    ])
    expect(harness.credentials.has('openai')).toBe(false)
  })

  test('models 带上元数据；enabled 用 enabledModels 白名单，空表全放行', async () => {
    const harness = makePort()
    const rows = await harness.port.models()
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      provider: 'anthropic',
      id: 'claude-opus-4-5',
      enabled: true,
      vision: true,
    })
    expect(rows[1]).toMatchObject({ id: 'gpt-5', enabled: true, vision: false })
    setSetting(harness.settings, 'enabledModels', ['openai/gpt-5'])
    const scoped = await harness.port.models()
    expect(scoped.map((m) => m.enabled)).toEqual([false, true])
  })

  /* omp 知识 #12：key 只进 credentials.set(provider, { type: 'api_key', key, source: 'login' })。 */
  test('setApiKey 之后日志里没有 key，也没有回传', async () => {
    const harness = makePort()
    await harness.port.setApiKey('openai', 'sk-secret-value')
    expect(harness.credentials.has('openai')).toBe(true)
    expect(harness.logged.join('\n')).not.toContain('sk-secret-value')
    expect(harness.logged.join('\n')).toContain('api key stored')
  })

  test('clearApiKey 只删 API Key 那一行（账号登录留着）并 fire', async () => {
    const harness = makePort()
    let fired = 0
    const sub = harness.port.onDidChange(() => {
      fired += 1
    })
    await harness.port.clearApiKey('anthropic')
    expect(harness.credentials.has('anthropic', 'api_key')).toBe(false)
    expect(harness.credentials.has('anthropic', 'oauth')).toBe(true)
    expect(fired).toBe(1)
    sub.dispose()
  })

  test('setModelEnabled：空表时先把可用清单写进白名单，再摘掉这一条', async () => {
    const harness = makePort()
    await harness.port.setModelEnabled({ provider: 'openai', id: 'gpt-5' }, false)
    expect(readEnabled(harness.settings)).toEqual(['anthropic/claude-opus-4-5'])
    await harness.port.setModelEnabled({ provider: 'openai', id: 'gpt-5' }, true)
    expect(readEnabled(harness.settings)).toEqual(['anthropic/claude-opus-4-5', 'openai/gpt-5'])
  })

  test('默认选择器带 :档位 后缀时 id 不被污染，档位作为显式意图读出', async () => {
    const harness = makePort()
    setSetting(harness.settings, 'modelRoles', { default: 'anthropic/claude-opus-4-5:max' })
    // 旧实现按第一个斜杠硬切，读出 id = 'claude-opus-4-5:max'
    expect(await harness.port.defaultModel()).toEqual({ provider: 'anthropic', id: 'claude-opus-4-5' })
    expect(await harness.port.defaultSelection()).toEqual({
      model: { provider: 'anthropic', id: 'claude-opus-4-5' },
      thinking: 'max',
    })
    // 目录外的选择器按字面去后缀，如实报出
    setSetting(harness.settings, 'modelRoles', { default: 'gone/old-model:low' })
    expect(await harness.port.defaultSelection()).toEqual({
      model: { provider: 'gone', id: 'old-model' },
      thinking: 'low',
    })
    setSetting(harness.settings, 'modelRoles', {})
    expect(await harness.port.defaultSelection()).toEqual({ model: null, thinking: null })
  })

  test('setDefaultModel：省略档位保留原后缀、null 去掉、非法档位拒绝；只发 onDidChangeDefaults', async () => {
    const harness = makePort()
    const counts = { change: 0, defaults: 0 }
    harness.port.onDidChange(() => {
      counts.change += 1
    })
    harness.port.onDidChangeDefaults(() => {
      counts.defaults += 1
    })
    await harness.port.setDefaultModel({ provider: 'anthropic', id: 'claude-opus-4-5' }, 'high')
    expect(readRole(harness.settings)).toBe('anthropic/claude-opus-4-5:high')
    await harness.port.setDefaultModel({ provider: 'openai', id: 'gpt-5' })
    expect(readRole(harness.settings)).toBe('openai/gpt-5:high')
    await harness.port.setDefaultModel({ provider: 'openai', id: 'gpt-5' }, null)
    expect(readRole(harness.settings)).toBe('openai/gpt-5')
    await expect(harness.port.setDefaultModel({ provider: 'openai', id: 'gpt-5' }, 'turbo')).rejects.toThrow()
    expect(readRole(harness.settings)).toBe('openai/gpt-5')
    await harness.port.setModelRole('default', 'anthropic/claude-opus-4-5:low')
    await harness.port.setDefaultThinking('medium')
    expect(counts).toEqual({ change: 0, defaults: 5 })
    // 别的角色活着的会话也在用：照旧走 onDidChange
    await harness.port.setModelRole('smol', 'openai/gpt-5')
    expect(counts).toEqual({ change: 1, defaults: 5 })
  })

  test('默认模型读写 modelRoles.default，defaultThinking 读写 defaultThinkingLevel', async () => {
    const harness = makePort()
    setSetting(harness.settings, 'modelRoles', { default: 'anthropic/claude-opus-4-5' })
    setSetting(harness.settings, 'defaultThinkingLevel', 'high')
    expect(await harness.port.defaultModel()).toEqual({ provider: 'anthropic', id: 'claude-opus-4-5' })
    await harness.port.setDefaultModel({ provider: 'openai', id: 'gpt-5' })
    expect(readRole(harness.settings)).toBe('openai/gpt-5')
    expect(await harness.port.defaultThinking()).toBe('high')
    await harness.port.setDefaultThinking(null)
    expect(harness.settings.getGlobalSettings().defaultThinkingLevel).toBeUndefined()
    /*
     * unset 之后读到的是 omp schema 自己的默认（defaultThinkingLevel 的默认是 'high'），
     * 不是 null —— 「谁都没配就是它自己的默认」是读一格的定义（settings-access.ts）。
     */
    // defaultThinking() 的返回类型是 string | null：omp schema 的默认在这里收窄一次
    const schemaDefault = settingDefault('defaultThinkingLevel')
    expect(await harness.port.defaultThinking()).toBe(typeof schemaDefault === 'string' ? schemaDefault : null)
  })

  test('角色清单与名字来自 omp；写入落 modelRoles.<role>，null 删掉，未知角色拒绝', async () => {
    const harness = makePort()
    const roles = await harness.port.modelRoles()
    const ids = roles.map((r) => r.role)
    /* omp 内置角色（MODEL_ROLE_IDS）全在，且两区都有 */
    for (const id of ['default', 'smol', 'slow', 'tiny', 'commit', 'task', 'image', 'judge']) expect(ids).toContain(id)
    expect(roles.find((r) => r.role === 'tiny')?.selector).toBeNull()
    expect(roles.find((r) => r.role === 'image')?.section).toBe('kind')
    expect(roles.find((r) => r.role === 'smol')?.candidates.map((c) => c.selector)).toContain('openai/gpt-5')

    await harness.port.setModelRole('tiny', 'openai/gpt-5:low')
    expect((harness.settings.getGlobalSettings().modelRoles as Record<string, unknown>).tiny).toBe('openai/gpt-5:low')
    expect((await harness.port.modelRoles()).find((r) => r.role === 'tiny')?.selector).toBe('openai/gpt-5:low')
    await harness.port.setModelRole('tiny', null)
    expect(
      (harness.settings.getGlobalSettings().modelRoles as Record<string, unknown> | undefined)?.tiny,
    ).toBeUndefined()
    await expect(harness.port.setModelRole('title', 'openai/gpt-5')).rejects.toThrow()
  })

  test('没配的角色报 omp 的实际去向：跟角色、跟当前对话、或 omp 自动挑中的那一个', async () => {
    const harness = makePort()
    const fallbackOf = async (role: string) => (await harness.port.modelRoles()).find((r) => r.role === role)?.fallback
    /* default 没配：smol 不继承，落到 omp 的优先级表；tiny 仍跟 smol（omp 的 ROLE_CONFIGURED_FALLBACK 不看 smol 配没配） */
    expect((await fallbackOf('smol'))?.kind).toBe('auto')
    expect(await fallbackOf('tiny')).toEqual({ kind: 'role', role: 'smol' })
    expect(await fallbackOf('memory')).toEqual({ kind: 'role', role: 'tiny' })
    expect(await fallbackOf('task')).toEqual({ kind: 'conversation' })
    expect(await fallbackOf('plan')).toEqual({ kind: 'conversation' })
    /* 没有图像模型：候选为空，自动也挑不出 */
    expect(await fallbackOf('image')).toEqual({ kind: 'auto', model: null })

    await harness.port.setDefaultModel({ provider: 'anthropic', id: 'claude-opus-4-5' })
    expect(await fallbackOf('smol')).toEqual({ kind: 'role', role: 'default' })
    /* advisor 只在 slow 配过时才跟它，否则 omp 自己挑一个强模型 */
    expect((await fallbackOf('advisor'))?.kind).toBe('auto')
    await harness.port.setModelRole('slow', 'openai/gpt-5')
    expect(await fallbackOf('advisor')).toEqual({ kind: 'role', role: 'slow' })
  })

  test('旧版 modelRoles.title：tiny 没配就迁进 tiny 并切 title.generator=tiny；tiny 已配只删旧键', async () => {
    const fresh = makePort()
    fresh.settings.setModelRole('title', 'openai/gpt-5')
    expect(await migrateLegacyTitleRole(fresh.settings)).toBe(true)
    const roles = fresh.settings.getGlobalSettings().modelRoles as Record<string, unknown>
    expect(roles.tiny).toBe('openai/gpt-5')
    expect(roles.title).toBeUndefined()
    expect(lookupGenerator(fresh.settings)).toBe('tiny')
    expect(await migrateLegacyTitleRole(fresh.settings)).toBe(false)

    const kept = makePort()
    kept.settings.setModelRole('tiny', 'anthropic/claude-opus-4-5')
    kept.settings.setModelRole('title', 'openai/gpt-5')
    await migrateLegacyTitleRole(kept.settings)
    const keptRoles = kept.settings.getGlobalSettings().modelRoles as Record<string, unknown>
    expect(keptRoles.tiny).toBe('anthropic/claude-opus-4-5')
    expect(keptRoles.title).toBeUndefined()
  })

  test('upsertCustomProvider 写进 models.yml、让 registry 重读，并把 provider 认成自定义', async () => {
    const harness = makePort()
    await harness.port.upsertCustomProvider({
      id: 'openai',
      name: 'Mine',
      api: 'openai-completions',
      baseUrl: 'https://mine.test/v1',
      models: [{ id: 'm1', name: 'M1', contextWindow: null, reasoning: false, vision: false }],
    })
    /* 自定义判据就是「models.yml 里有没有这一格」 */
    const withMine = await harness.port.providers()
    expect(withMine.find((provider) => provider.id === 'openai')).toMatchObject({ custom: true })
    expect(harness.reloads.length).toBeGreaterThan(0)
    await harness.port.removeCustomProvider('openai')
    const after = await harness.port.providers()
    expect(after.find((provider) => provider.id === 'openai')).toMatchObject({ custom: false })
  })
})

describe('model-helpers', () => {
  test('aliasOf 是 provider/id；enabledMatcher 空表全放行', () => {
    expect(aliasOf({ provider: 'a', id: 'b' })).toBe('a/b')
    expect(enabledMatcher([])({ provider: 'a', id: 'b' })).toBe(true)
    expect(enabledMatcher(['a/*'])({ provider: 'a', id: 'b' })).toBe(true)
    expect(enabledMatcher(['a/b'])({ provider: 'a', id: 'b' })).toBe(true)
    expect(enabledMatcher(['a/c'])({ provider: 'a', id: 'b' })).toBe(false)
  })

  test('nextEnabledPatterns 的增删语义', () => {
    const available = ['a/1', 'a/2']
    expect(nextEnabledPatterns([], available, { provider: 'a', id: '1' }, false)).toEqual(['a/2'])
    expect(nextEnabledPatterns(['a/2'], available, { provider: 'a', id: '1' }, true)).toEqual(['a/2', 'a/1'])
    expect(nextEnabledPatterns(['a/1', 'a/2'], available, { provider: 'a', id: '1' }, true)).toEqual(['a/1', 'a/2'])
    expect(nextEnabledPatterns(['a/bogus'], available, { provider: 'a', id: '1' }, false)).toEqual(['a/bogus'])
  })

  test('stringArrayOf 丢掉非字符串项', () => {
    expect(stringArrayOf(['a', 1, null, 'b'])).toEqual(['a', 'b'])
    expect(stringArrayOf('nope')).toEqual([])
  })
})

function setSetting(settings: Settings, path: string, value: unknown): void {
  settingHandle(path).set(settings, value as never)
}

function settingHandle(path: string): { set(scope: Settings, value: never): void } {
  const handle = lookup(path)
  if (handle === undefined) throw new Error(`没有这个设置：${path}`)
  return handle as unknown as { set(scope: Settings, value: never): void }
}

/** omp 没有 Settings.set(path, v)：测试里的写入也走 Setting 句柄（与 settings-access.ts 同一条路）。 */
function readEnabled(settings: Settings): readonly string[] {
  const value = settings.getGlobalSettings().enabledModels
  return Array.isArray(value) ? (value as string[]) : []
}

/** 某一格 schema 自己的默认（与端口读到的「谁都没配」是同一个值）。 */
function settingDefault(path: string): unknown {
  return lookup(path)?.default
}

function readRole(settings: Settings): unknown {
  const value = settings.getGlobalSettings().modelRoles
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>).default : undefined
}

/** title.generator 的当前值（走 omp 的设置句柄读，避免依赖 getGlobalSettings 的嵌套形状） */
function lookupGenerator(settings: Settings): unknown {
  return (lookup('title.generator') as unknown as { get(s: Settings): unknown }).get(settings)
}
