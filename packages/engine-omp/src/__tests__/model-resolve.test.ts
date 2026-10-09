import { describe, expect, test } from 'bun:test'
import { resolveSessionModel, splitModelSelector } from '../model-resolve'

/*
 * 真机故障（2026-10-08 用户截图）：新建对话发第一句 → AppError
 * `undefined is not an object (evaluating 'identity.class')`。
 *
 * 根因是会话初始化时把注册表里的模型**瘦身**成 `{provider,id}` 再交给
 * `createAgentSession`，而 SDK 的模型对象要读 `identity.class`、`api`、`baseUrl`
 * 这些格（sdk.ts 的 resolveDelegationBias / streamDispatch 直接取字段）。
 * 这条用例钉住的是「回传的就是注册表里那一条实例本身」。
 */

interface FakeModel {
  readonly provider: string
  readonly id: string
  readonly api: string
  readonly identity: { readonly class: string }
}

const MODELS: readonly FakeModel[] = [
  { provider: 'deepseek', id: 'deepseek-flash', api: 'openai-completions', identity: { class: 'deepseek' } },
  { provider: 'workbuddy-ai', id: 'deepseek-v4.1-flash', api: 'openai-completions', identity: { class: 'deepseek' } },
]

function registryOf(models: readonly FakeModel[], configured: readonly string[]) {
  return {
    find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
    hasConfiguredAuth: (model: FakeModel) => configured.includes(model.provider),
  }
}

describe('splitModelSelector', () => {
  test('整串 provider/id 只切第一个分隔符（id 自己可以带斜杠）', () => {
    expect(splitModelSelector('deepseek/deepseek-flash')).toEqual({ provider: 'deepseek', id: 'deepseek-flash' })
    expect(splitModelSelector('workbuddy-ai/deepseek-v4.1-flash')).toEqual({
      provider: 'workbuddy-ai',
      id: 'deepseek-v4.1-flash',
    })
  })

  test('没有分隔符、空 provider、空 id 都不是合法选择器', () => {
    expect(splitModelSelector('deepseek-flash')).toBeNull()
    expect(splitModelSelector('/deepseek-flash')).toBeNull()
    expect(splitModelSelector('deepseek/')).toBeNull()
  })
})

describe('resolveSessionModel', () => {
  test('交回注册表里那一条实例本身（SDK 要读 identity 等格）', () => {
    const found = resolveSessionModel(registryOf(MODELS, ['deepseek']), 'deepseek/deepseek-flash')

    expect(found).toBe(MODELS[0]!)
    /* 判据的核心：拿得到完整实例的字段，不只是 provider/id。 */
    expect(found?.identity.class).toBe('deepseek')
    expect(found?.api).toBe('openai-completions')
  })

  test('没配过凭据的 provider 交回 null（交给 SDK 兜底，不替用户换一条）', () => {
    expect(resolveSessionModel(registryOf(MODELS, ['deepseek']), 'workbuddy-ai/deepseek-v4.1-flash')).toBeNull()
  })

  test('目录里没有、选择器坏、选择器缺席都交回 null', () => {
    const registry = registryOf(MODELS, ['deepseek'])
    expect(resolveSessionModel(registry, 'deepseek/下架了')).toBeNull()
    expect(resolveSessionModel(registry, '不是选择器')).toBeNull()
    expect(resolveSessionModel(registry, null)).toBeNull()
  })
})
