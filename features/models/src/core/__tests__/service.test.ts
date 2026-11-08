import { describe, expect, test } from 'bun:test'
import { createFakeEngine } from '@poietica/engine-testkit'
import { AppError } from '@poietica/foundation'
import { createTestLogger, type TestLogRecord } from '@poietica/test-kit'
import type { ModelInfo, ProviderInfo } from '../../contract'
import { type ApiKeyVault, restoreApiKeys } from '../api-keys'
import { createModelsService } from '../service'

/** 凭据库的替身：一张内存表；`failPut` 模拟系统加密不可用 */
function memoryVault(o: { failPut?: boolean } = {}): ApiKeyVault & { readonly data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    all: async () => Object.fromEntries(data),
    put: async (provider, key) => {
      if (o.failPut === true) throw new AppError('secrets.unavailable', '系统的凭据加密不可用，密钥没有保存')
      data.set(provider, key)
    },
    delete: async (provider) => {
      data.delete(provider)
    },
  }
}

function make(providers: ProviderInfo[] = [], models: ModelInfo[] = [], vault = memoryVault()) {
  const engine = createFakeEngine()
  const logger = createTestLogger()
  const records: TestLogRecord[] = logger.records
  let changed = 0
  const service = createModelsService({
    // FakeEngine 的 models 端口本身就是内存数组实现；providers 先灌进去。
    models: {
      ...engine.models,
      async providers() {
        return providers
      },
      async models() {
        return models
      },
    },
    vault,
    logger,
    emitChanged: () => {
      changed += 1
    },
  })
  return { service, records, changed: () => changed, engine, vault }
}

const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic', configured: false, custom: false, authKind: 'api_key', docsUrl: null },
  { id: 'mine', name: 'Mine', configured: true, custom: true, authKind: 'api_key', docsUrl: null },
]

describe('models 服务（14 页 §6.5）', () => {
  test('模型角色：清单与候选来自引擎；设了能读回，传 null 删掉；引擎不认的角色被拒', async () => {
    const { service, changed } = make(PROVIDERS)
    const tiny = async () => (await service.roles()).find((r) => r.role === 'tiny')
    expect((await tiny())?.selector).toBeNull()

    await service.setRole('tiny', 'anthropic/claude-haiku')
    expect((await tiny())?.selector).toBe('anthropic/claude-haiku')

    /* 选回「未设置」= 传 null：读回来必须是 null，而不是一条空串。 */
    await service.setRole('tiny', null)
    expect((await tiny())?.selector).toBeNull()
    expect(changed()).toBeGreaterThanOrEqual(2)
    /* 角色名单由引擎定，服务不自列：替身不认的 title 被拒 */
    await expect(service.setRole('title', 'anthropic/claude-haiku')).rejects.toThrow()
  })

  test('setApiKey 之后测试 logger 收到的全部字段中都不含 sk-ant——…', async () => {
    const { service, records } = make(PROVIDERS)
    await service.setApiKey('anthropic', 'sk-ant-xxxxxxxx')
    const dump = JSON.stringify(records)
    expect(dump).not.toContain('sk-ant')
    expect(dump).toContain('anthropic')
  })

  test('setApiKey 先落凭据库再交给引擎内存；clearApiKey 两边都撤（ADR-008）', async () => {
    const { service, engine, vault } = make(PROVIDERS)
    await service.setApiKey('anthropic', 'sk-ant-xxxxxxxx')
    expect(vault.data.get('anthropic')).toBe('sk-ant-xxxxxxxx')
    expect(engine.apiKeys.get('anthropic')).toBe('sk-ant-xxxxxxxx')
    await service.clearApiKey('anthropic')
    expect(vault.data.has('anthropic')).toBe(false)
    expect(engine.apiKeys.has('anthropic')).toBe(false)
  })

  test('凭据库写不进去（系统加密不可用）：setApiKey 失败，引擎里也没有这把钥匙', async () => {
    const { service, engine } = make(PROVIDERS, [], memoryVault({ failPut: true }))
    await expect(service.setApiKey('anthropic', 'sk-ant-xxxxxxxx')).rejects.toMatchObject({
      code: 'secrets.unavailable',
    })
    expect(engine.apiKeys.has('anthropic')).toBe(false)
  })

  test('setApiKey 一个不存在的服务商 → models.provider_not_found', async () => {
    const { service } = make(PROVIDERS)
    const err = await service.setApiKey('nope', 'sk-ant-xxxxxxxx').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe('models.provider_not_found')
  })

  test('removeCustomProvider(内置) → models.builtin_provider_readonly', async () => {
    const { service } = make(PROVIDERS)
    const err = await service.removeCustomProvider('anthropic').catch((e: unknown) => e)
    expect((err as AppError).code).toBe('models.builtin_provider_readonly')
  })

  test('upsertCustomProvider 与内置同名 → models.builtin_provider_readonly', async () => {
    const { service } = make(PROVIDERS)
    const err = await service
      .upsertCustomProvider({ id: 'anthropic', name: 'X', api: 'anthropic-messages', baseUrl: 'https://x', models: [] })
      .catch((e: unknown) => e)
    expect((err as AppError).code).toBe('models.builtin_provider_readonly')
  })

  test('自定义服务商可以删（非内置）', async () => {
    const { service, changed } = make(PROVIDERS)
    await service.removeCustomProvider('mine')
    expect(changed()).toBeGreaterThan(0)
  })

  test('每次写方法都 emit models.changed', async () => {
    const { service, changed } = make(PROVIDERS)
    await service.setEnabled({ provider: 'anthropic', id: 'claude' }, false)
    expect(changed()).toBe(1)
    await service.setDefaults({ model: { provider: 'anthropic', id: 'claude' } })
    expect(changed()).toBe(2)
  })

  test('defaults 读两条默认值；setDefaults 只写给了的那些', async () => {
    const { service } = make(PROVIDERS)
    await service.setDefaults({ model: { provider: 'a', id: 'b' }, thinking: 'high' })
    const d = await service.defaults()
    expect(d.model).toEqual({ provider: 'a', id: 'b' })
    expect(d.thinking).toBe('high')
    await service.setDefaults({ thinking: null })
    expect((await service.defaults()).thinking).toBeNull()
    expect((await service.defaults()).model).toEqual({ provider: 'a', id: 'b' })
  })

  test('clearApiKey 记日志也只带服务商名', async () => {
    const { service, records } = make(PROVIDERS)
    await service.clearApiKey('anthropic')
    expect(JSON.stringify(records)).toContain('api key cleared')
  })

  test('启动：引擎磁盘上的旧钥匙搬进凭据库，再把凭据库全部交给引擎内存；搬不进的留在原处', async () => {
    const engine = createFakeEngine({ storedApiKeys: [{ provider: 'openai', key: 'sk-legacy' }] })
    const vault = memoryVault()
    vault.data.set('anthropic', 'sk-ant-vault')
    const logger = createTestLogger()
    expect(await restoreApiKeys({ vault, models: engine.models, logger })).toEqual(['openai'])
    expect(vault.data.get('openai')).toBe('sk-legacy')
    expect(engine.apiKeys.get('openai')).toBe('sk-legacy')
    expect(engine.apiKeys.get('anthropic')).toBe('sk-ant-vault')
    expect(await engine.models.storedApiKeys()).toEqual([])
    expect(JSON.stringify(logger.records)).not.toContain('sk-')

    const stuck = createFakeEngine({ storedApiKeys: [{ provider: 'openai', key: 'sk-legacy' }] })
    expect(await restoreApiKeys({ vault: memoryVault({ failPut: true }), models: stuck.models, logger })).toEqual([])
    expect(await stuck.models.storedApiKeys()).toEqual([{ provider: 'openai', key: 'sk-legacy' }])
  })

  test('logout 只认登录名单里的那一家（按凭据记在的 provider），退出后通知目录变了', async () => {
    const out: string[] = []
    let changed = 0
    const service = createModelsService({
      models: {
        ...createFakeEngine().models,
        loginProviders: async () => [
          {
            id: 'openai-codex-device',
            name: 'ChatGPT',
            provider: 'openai-codex',
            available: true,
            authenticated: true,
            account: 'me@example.com',
            issuesApiKey: false,
          },
        ],
        logout: async (provider) => {
          out.push(provider)
        },
      },
      vault: memoryVault(),
      logger: createTestLogger(),
      emitChanged: () => {
        changed += 1
      },
    })
    await service.logout('openai-codex')
    expect(out).toEqual(['openai-codex'])
    expect(changed).toBe(1)
    await expect(service.logout('openai-codex-device')).rejects.toBeInstanceOf(AppError)
    expect(changed).toBe(1)
  })
})
