import { describe, expect, test } from 'bun:test'
import { openDatabase } from '@poietica/storage-sqlite'
import { usageContract } from '../../contract'
import { migrations } from '../migrations'
import { createUsageRepo } from '../repo'

function makeRepo() {
  const db = openDatabase(':memory:')
  for (const m of migrations) db.forModule('usage').exec(m.sql!)
  return { db, repo: createUsageRepo(db.forModule('usage')) }
}

describe('US-1（core 半边）：tokenDays / modelDays 的按天分组', () => {
  test('跨 3 天 2 个模型：tokenDays 3 行，modelDays 按 day/provider/model 分组', () => {
    const { db, repo } = makeRepo()
    const rows = [
      ['2026-10-01', 'anthropic', 'opus', 100, 10],
      ['2026-10-01', 'anthropic', 'opus', 50, 5],
      ['2026-10-02', 'openai', 'gpt', 20, 2],
      ['2026-10-03', 'anthropic', 'opus', 1, 1],
    ] as const
    let at = 0
    for (const [day, provider, model, input, output] of rows) {
      repo.insert({
        threadId: 't1',
        day,
        at: at++,
        provider,
        model,
        input,
        output,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
      })
    }

    const days = repo.tokenDays('2026-10-01', '2026-10-03')
    expect(days.map((d) => d.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-03'])
    expect(days[0]!.input).toBe(150)
    expect(days[0]!.output).toBe(15)

    const models = repo.modelDays('2026-10-01', '2026-10-03')
    expect(models.map((m) => `${m.day} ${m.provider}/${m.model}`)).toEqual([
      '2026-10-01 anthropic/opus',
      '2026-10-02 openai/gpt',
      '2026-10-03 anthropic/opus',
    ])
    db.close()
  })
})

describe('US-5: from > to', () => {
  test('契约拒绝倒置区间，保留相等区间', () => {
    const def = usageContract.methods.find((m) => m.name === 'usage.tokenDays')!
    expect(def.params.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success).toBe(false)
    expect(def.params.safeParse({ from: '2026-10-01', to: '2026-10-01' }).success).toBe(true)
  })

  test('超过 400 天同样被拒；三个按天方法共用同一条规则', () => {
    for (const name of ['usage.tokenDays', 'usage.modelDays', 'usage.messageCount']) {
      const def = usageContract.methods.find((m) => m.name === name)!
      expect(def.params.safeParse({ from: '2026-10-02', to: '2026-10-01' }).success).toBe(false)
      expect(def.params.safeParse({ from: '2024-01-01', to: '2026-10-01' }).success).toBe(false)
    }
  })
})
