import { describe, expect, test } from 'bun:test'
import { fakeClock } from '@poietica/test-kit'
import { createRollScheduler, FINISH_MS, MIN_DWELL_MS, type Promotion } from '../roll-scheduler'

const line = (key: string, text = key) => ({ key, text })

function setup() {
  const clock = fakeClock()
  const rolls = createRollScheduler(line('a', '第一句'), clock)
  const seen: Promotion[] = []
  rolls.onPromote((promotion) => seen.push(promotion))
  return { clock, rolls, seen }
}

describe('roll-scheduler', () => {
  test('同 key：只更新文字，不换句', () => {
    const { rolls, seen } = setup()
    rolls.offer(line('a', '第一句还在写'), null)
    expect(rolls.shown().text).toBe('第一句还在写')
    expect(seen).toHaveLength(0)
  })

  test('旧句已露面很久：下一句出现后 FINISH_MS 换上', () => {
    const { clock, rolls, seen } = setup()
    clock.advance(5000)
    rolls.offer(line('b'), null)
    clock.advance(FINISH_MS - 1)
    expect(seen).toHaveLength(0)
    clock.advance(1)
    expect(seen.map((p) => p.snapshot.key)).toEqual(['b'])
    expect(seen[0]?.fast).toBe(false)
  })

  test('旧句刚露面：等它满 MIN_DWELL_MS', () => {
    const { clock, rolls, seen } = setup()
    clock.advance(100)
    rolls.offer(line('b'), null)
    clock.advance(MIN_DWELL_MS - 101)
    expect(seen).toHaveLength(0)
    clock.advance(1)
    expect(seen).toHaveLength(1)
  })

  test('等待期间不断来新句：换句时刻不后推，只换上最新那句，并用快速刷（v1 在这里会一直不换）', () => {
    const { clock, rolls, seen } = setup()
    clock.advance(5000)
    rolls.offer(line('b'), null)
    clock.advance(100)
    rolls.offer(line('c'), null)
    clock.advance(100)
    rolls.offer(line('d'), null)
    clock.advance(FINISH_MS - 200)
    expect(seen.map((p) => p.snapshot.key)).toEqual(['d'])
    expect(seen[0]?.fast).toBe(true)
  })

  test('同一句里反复渲染（offer 同 key 很多次）不影响换句时刻（v1 在这里每次换句都要等满上限）', () => {
    const { clock, rolls, seen } = setup()
    clock.advance(5000)
    rolls.offer(line('b'), null)
    for (let index = 0; index < 10; index += 1) {
      clock.advance(10)
      rolls.offer(line('b', `b${String(index)}`), null)
    }
    clock.advance(FINISH_MS - 100)
    expect(seen).toHaveLength(1)
  })

  test('previous 补完旧句，只许变长', () => {
    const { rolls } = setup()
    rolls.offer(line('b'), line('a', '第一句。'))
    expect(rolls.shown().text).toBe('第一句。')
    rolls.offer(line('b'), line('a', '第一'))
    expect(rolls.shown().text).toBe('第一句。')
  })

  test('少动效：新句立即换上', () => {
    const { rolls, seen } = setup()
    rolls.setImmediate(true)
    rolls.offer(line('b'), null)
    expect(seen).toHaveLength(1)
  })

  test('dispose 后重新订阅（StrictMode 的模拟卸载）：仍按原定时刻换句，不后推', () => {
    const { clock, rolls } = setup()
    const seen: Promotion[] = []
    clock.advance(1000)
    rolls.offer(line('b'), null)
    rolls.dispose()
    clock.advance(100)
    rolls.onPromote((promotion) => seen.push(promotion))
    clock.advance(FINISH_MS - 100)
    expect(seen).toHaveLength(1)
    expect(rolls.shown().key).toBe('b')
  })

  test('dispose 之后推进时钟，不再有回调', () => {
    const { clock, rolls, seen } = setup()
    rolls.offer(line('b'), null)
    rolls.dispose()
    clock.advance(10_000)
    expect(seen).toHaveLength(0)
  })
})
