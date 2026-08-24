import { describe, expect, it } from 'bun:test'
import { builtinAgentProviders } from '../provider-presets'

/*
 * 内置表自己要成立的两条，与任何一家 agent 的文档形状无关 —— 那些用例在
 * kimi/__tests__ 下。
 */

describe('builtinAgentProviders', () => {
  it('每一条模型都声明了上下文窗口', () => {
    for (const preset of builtinAgentProviders()) {
      for (const model of preset.models) {
        expect(
          typeof model.maxContextSize === 'number' && model.maxContextSize > 0,
          `${preset.id}/${model.id} 缺 maxContextSize（对方会把没有 limit.context 的模型丢掉）`,
        ).toBe(true)
      }
    }
  })

  it('声明的推理档位全是小写', () => {
    for (const preset of builtinAgentProviders()) {
      for (const model of preset.models) {
        for (const effort of model.thinking?.efforts ?? []) {
          expect(
            effort === effort.toLowerCase(),
            `${preset.id}/${model.id} 的档位 ${effort} 不是小写 —— 档位原样进请求体，大小写是契约`,
          ).toBe(true)
        }
      }
    }
  })
})
