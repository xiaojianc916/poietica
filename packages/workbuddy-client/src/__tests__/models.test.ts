import { describe, expect, test } from 'bun:test'
import { listModels } from '../session'

describe('WorkBuddy 模型目录', () => {
  test('从插件静态表读出 chat 模型', async () => {
    const models = await listModels()
    const deepseek = models.find((model) => model.id === 'deepseek-v4.1-flash')
    expect(deepseek).toBeDefined()
    expect(deepseek?.api).toBe('chat')
    expect(deepseek?.contextWindow).toBeGreaterThan(0)
    expect(models.every((model) => model.id !== '')).toBe(true)
  })

  test('0.2.13 的目录里带思考档位的模型仍然可读', async () => {
    const models = await listModels()
    /* deepseek-v4.1-flash 在 0.2.7 起就有 none/low/high/max 四档 */
    const deepseek = models.find((model) => model.id === 'deepseek-v4.1-flash')
    expect(deepseek?.reasoning).toBe(true)
    /* 静态表里只有 chat，Messages 路留给实时目录 */
    expect(models.every((model) => model.api === 'chat')).toBe(true)
  })
})
