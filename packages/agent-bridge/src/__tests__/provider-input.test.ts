/*
 * provider 输入的自检：线上来的 null 不许炸。
 *
 * 这一条有前科：界面发来的模型里 `supportEfforts` 是 `null`（Rust 的
 * `Option::None` 经 `serde_json::json!` 序列化成 null），而这一层当时按
 * `=== undefined` 判缺席 —— null 从那个判据漏过去，后面 `.length` 直接炸：
 *
 *     null is not an object (evaluating 'model.supportEfforts.length')
 *
 * 判据因此是「每一格都可能缺席、可能是 null」，逐格钉住。
 */

import { describe, expect, it } from 'bun:test'

import { definitionOf } from '../catalog.ts'

/** 界面真实发出来的那一份：可缺席的格全是 null。 */
const ALL_NULL = {
  providerType: 'openai',
  baseUrl: null,
  models: [
    {
      model: 'deepseek-v4-pro',
      maxContextSize: 1000000,
      displayName: null,
      capabilities: null,
      maxOutputSize: null,
      supportEfforts: null,
    },
  ],
}

describe('provider 输入翻成 models.yml 的定义', () => {
  it('每一格都是 null 也不炸，且不写出空壳字段', () => {
    const definition = definitionOf(ALL_NULL, 'p')

    expect(definition).toEqual({
      id: 'p',
      baseUrl: null,
      api: 'openai-completions',
      models: [{ id: 'deepseek-v4-pro', contextWindow: 1000000 }],
    })
  })

  it('null 与 undefined 一视同仁：两种缺席都不进结果', () => {
    const withNull = definitionOf(ALL_NULL, 'p')
    const withUndefined = definitionOf(
      {
        providerType: 'openai',
        models: [{ model: 'deepseek-v4-pro', maxContextSize: 1000000 }],
      },
      'p',
    )

    expect(withNull).toEqual(withUndefined)
  })

  it('给了档位就是推理模型，efforts 原样带上', () => {
    const definition = definitionOf(
      {
        providerType: 'openai',
        baseUrl: 'https://api.deepseek.com',
        models: [
          {
            model: 'deepseek-v4-pro',
            maxContextSize: 1000000,
            displayName: 'DeepSeek V4 Pro',
            maxOutputSize: 8192,
            supportEfforts: ['low', 'high', 'max'],
            capabilities: ['thinking', 'image'],
          },
        ],
      },
      'p',
    )

    expect(definition.models[0]).toEqual({
      id: 'deepseek-v4-pro',
      name: 'DeepSeek V4 Pro',
      contextWindow: 1000000,
      maxTokens: 8192,
      reasoning: true,
      efforts: ['low', 'high', 'max'],
      input: ['text', 'image'],
    })
  })

  it('空档位表不算「有档位」—— 回空表等于说一个档都没有', () => {
    const definition = definitionOf(
      {
        providerType: 'openai',
        models: [{ model: 'm', maxContextSize: 1, supportEfforts: [] }],
      },
      'p',
    )

    expect(definition.models[0]).toEqual({ id: 'm', contextWindow: 1 })
  })

  it('界面那几种 API 格式对齐到上游的 api 取值', () => {
    const apiOf = (providerType: string): string | null =>
      definitionOf({ providerType, models: [{ model: 'm', maxContextSize: 1 }] }, 'p').api

    expect(apiOf('openai')).toBe('openai-completions')
    expect(apiOf('openai_responses')).toBe('openai-responses')
    expect(apiOf('anthropic')).toBe('anthropic-messages')
    expect(apiOf('google-genai')).toBe('google-generative-ai')
    expect(apiOf('vertexai')).toBe('google-vertex')
    /* 认不出的原样透传：让上游的 schema 去拒，这里不替它猜。 */
    expect(apiOf('something-new')).toBe('something-new')
  })

  it('空字符串的显示名不算名字', () => {
    const definition = definitionOf(
      {
        providerType: 'openai',
        models: [{ model: 'm', maxContextSize: 1, displayName: '' }],
      },
      'p',
    )

    expect(definition.models[0]).toEqual({ id: 'm', contextWindow: 1 })
  })
})
