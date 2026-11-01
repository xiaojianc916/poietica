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
})
