import { describe, expect, test } from 'bun:test'
import { createFakeEngine } from '@poietica/engine-testkit'
import { AppError } from '@poietica/foundation'
import { createTestLogger, type TestLogRecord } from '@poietica/test-kit'
import type { ModelInfo, ProviderInfo } from '../../contract'
import { createModelsService } from '../service'

function make(providers: ProviderInfo[] = [], models: ModelInfo[] = []) {
  const engine = createFakeEngine()
  const logger = createTestLogger()
  const records: TestLogRecord[] = logger.records
  let changed = 0
  const service = createModelsService({
    // FakeEngine 的 models 端口本身就是内存数组实现；providers 先灌进去
    models: {
      ...engine.models,
      async providers() {
        return providers
      },
      async models() {
        return models
      },
    },
    logger,
    emitChanged: () => {
      changed += 1
    },
  })
  return { service, records, changed: () => changed, engine }
}

const PROVIDERS: ProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic', configured: false, custom: false, authKind: 'api_key', docsUrl: null },
  { id: 'mine', name: 'Mine', configured: true, custom: true, authKind: 'api_key', docsUrl: null },
]

describe('models 服务（14 页 §6.5）', () => {
  test('setApiKey 之后测试 logger 收到的全部字段中都不含 sk-ant——…', async () => {
    const { service, records } = make(PROVIDERS)
    await service.setApiKey('anthropic', 'sk-ant-xxxxxxxx')
    const dump = JSON.stringify(records)
    expect(dump).not.toContain('sk-ant')
    expect(dump).toContain('anthropic')
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

  test('providers 与 catalog 直接转发', async () => {
    const { service } = make(PROVIDERS)
    expect((await service.providers()).length).toBe(2)
    expect(await service.catalog()).toEqual([])
  })
})
