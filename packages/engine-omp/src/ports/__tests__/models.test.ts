import '../../__tests__/omp-home'

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
  /** agent.db 里的凭据（credentials.has 的记账） */
  readonly credentials: Set<string>
  /** omp 自己的鉴权判据（hasConfiguredAuth 的记账）——写 key、写 models.yml、免密钥端点都会让它为真 */
  readonly authorized: Set<string>
  readonly logged: string[]
  /** registry 重读的次数（models.yml 写完之后必须重读） */
  readonly reloads: number[]
  /** 登录之后只刷那一家（refreshProvider） */
  readonly refreshed: string[]
}

function makePort(): Harness {
  const dir = tempDir()
  const settings = Settings.isolated()
  const credentials = new Set<string>(['anthropic'])
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
        { id: 'anthropic', name: 'Claude Pro/Max', available: true },
        { id: 'openai-codex-device', name: 'ChatGPT（设备码）', available: true, storeCredentialsAs: 'openai-codex' },
      ],
      authenticated: (provider) => credentials.has(provider),
      login: async (providerId, ctrl) => {
        ctrl.onAuth({ url: `https://auth.example/${providerId}`, launchUrl: 'http://127.0.0.1:1455/go' })
        const code = await ctrl.onPrompt({ message: 'code', secret: true })
        credentials.add(providerId === 'openai-codex-device' ? 'openai-codex' : providerId)
        return { type: 'oauth', email: `${code}@example.com` }
      },
    },
    /* 角色目录用 omp 真身（config/model-roles），只把注册表换成两条模型 */
    roles: ompRolesOf(settings, { getAvailable: () => MODELS }),
    credentials: {
      has: (provider) => credentials.has(provider),
      set: (provider) => {
        credentials.add(provider)
        authorized.add(provider)
        return Promise.resolve()
      },
      remove: (provider) => {
        credentials.delete(provider)
        authorized.delete(provider)
        return Promise.resolve()
      },
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

describe('ModelsPort 订阅登录', () => {
  test('loginProviders 照 omp 名单报，凭据记在 storeCredentialsAs 名下', async () => {
    const harness = makePort()
    expect(await harness.port.loginProviders()).toEqual([
      { id: 'anthropic', name: 'Claude Pro/Max', provider: 'anthropic', available: true, authenticated: true },
      {
        id: 'openai-codex-device',
        name: 'ChatGPT（设备码）',
        provider: 'openai-codex',
        available: true,
        authenticated: false,
      },
    ])
  })

  test('login 把网址与要填的格子交给宿主（secret 不拒绝），成功后只刷那一家并报身份', async () => {
    const harness = makePort()
    const seen: string[] = []
    const identity = await harness.port.login('openai-codex-device', {
      onAuth: (info) => seen.push(`auth ${info.url} ${info.launchUrl}`),
      onProgress: (message) => seen.push(`progress ${message}`),
      onPrompt: async (prompt) => {
        seen.push(`prompt secret=${prompt.secret}`)
        return 'me'
      },
      signal: new AbortController().signal,
    })
    expect(seen).toEqual([
      'auth https://auth.example/openai-codex-device http://127.0.0.1:1455/go',
      'prompt secret=true',
    ])
    expect(identity).toEqual({ kind: 'oauth', email: 'me@example.com', orgName: null })
    expect(harness.refreshed).toEqual(['openai-codex'])
    expect(harness.credentials.has('openai-codex')).toBe(true)
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

  test('clearApiKey 删凭据并 fire', async () => {
    const harness = makePort()
    let fired = 0
    const sub = harness.port.onDidChange(() => {
      fired += 1
    })
    await harness.port.clearApiKey('anthropic')
    expect(harness.credentials.has('anthropic')).toBe(false)
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
