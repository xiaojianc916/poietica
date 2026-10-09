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
import { OmpModelsPort } from '../models'
import { CustomProvidersFile, modelsFilePath } from '../models-file'

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
  readonly configured: Set<string>
  readonly logged: string[]
  /** registry 重读的次数（models.yml 写完之后必须重读） */
  readonly reloads: number[]
}

function makePort(): Harness {
  const dir = tempDir()
  const settings = Settings.isolated()
  const configured = new Set<string>(['anthropic'])
  const logged: string[] = []
  const logger: Logger = {
    debug: () => undefined,
    info: (message, data) => logged.push(`${message} ${JSON.stringify(data ?? null)}`),
    warn: (message, data) => logged.push(`${message} ${JSON.stringify(data ?? null)}`),
    error: () => undefined,
    child: () => logger,
  }
  const reloads: number[] = []
  const noteReload = (): void => {
    reloads.push(reloads.length)
  }
  const port = new OmpModelsPort({
    registry: {
      all: () => MODELS,
      available: () => MODELS,
      find: (provider, id) => MODELS.find((model) => model.provider === provider && model.id === id),
      hasConfiguredAuth: () => true,
      hydrateCredentialScopedModelCaches: () => Promise.resolve(),
      refreshInBackground: () => undefined,
    },
    credentials: {
      has: (provider) => configured.has(provider),
      set: (provider) => {
        configured.add(provider)
        return Promise.resolve()
      },
      remove: (provider) => {
        configured.delete(provider)
        return Promise.resolve()
      },
    },
    root: settings,
    customProviders: new CustomProvidersFile({
      file: modelsFilePath(dir),
      logger,
      /* 规则 3：写完 models.yml 让 registry 重新读取 —— 与端口自己的 reload 是同一件事 */
      reload: noteReload,
    }),
    logger,
    reload: () => {
      reloads.push(reloads.length)
      return Promise.resolve()
    },
  })
  return { port, settings, configured, logged, reloads }
}

describe('ModelsPort', () => {
  test('providers 的 configured 来自凭据，custom 来自 models.yml', async () => {
    const harness = makePort()
    const providers = await harness.port.providers()
    expect(providers.map((p) => [p.id, p.configured, p.custom])).toEqual([
      ['anthropic', true, false],
      ['openai', false, false],
    ])
    expect(providers.every((p) => p.authKind === 'api_key' && p.docsUrl === null)).toBe(true)
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
    expect(harness.configured.has('openai')).toBe(true)
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
    expect(harness.configured.has('anthropic')).toBe(false)
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

/** omp 18.5.0 没有 Settings.set(path, v)：测试里的写入也走 Setting 句柄（与 settings-access.ts 同一条路）。 */
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
