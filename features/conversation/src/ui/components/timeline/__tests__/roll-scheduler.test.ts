import { describe, expect, it } from 'bun:test'
import { fakeClock } from '@poietica/test-kit'
import { createRollScheduler, END_HOLD_MS, MAX_WAIT_MS, MIN_VISIBLE_MS, type Promotion } from '../roll-scheduler'

/*
 * 什么时候换句。
 *
 * 三条规则互相拉扯，缺一条都不行：
 *   • 至少露面 MIN_VISIBLE_MS —— 不然刚刷上去就被刷走，人根本没读到；
 *   • 到位后再停 END_HOLD_MS —— 划到句尾立刻被刷掉，等于白划；
 *   • 最多等 MAX_WAIT_MS —— 快模型一秒能写好几句，等下去组头永远落后。
 *
 * 还有一条不在时间里的规则：等待期间又来了新句子，就把等待的那句换掉。补播中间那些句子是
 * 在演「过去的事」，而这一格说的是「现在」。
 */

function line(key: string, text = key): { readonly key: string; readonly text: string } {
  return { key, text }
}

/** 一座能记下每一次提升的调度器。 */
function harness(immediate = false): {
  readonly scheduler: ReturnType<typeof createRollScheduler>
  readonly promotions: Promotion[]
  readonly clock: ReturnType<typeof fakeClock>
} {
  const clock = fakeClock()
  const scheduler = createRollScheduler(line('a'), clock, immediate)
  const promotions: Promotion[] = []

  scheduler.onPromote((promotion) => promotions.push(promotion))

  return { scheduler, promotions, clock }
}

describe('原地生长不换句', () => {
  it('同 key 的 offer 只更新文字，不触发提升', () => {
    const { scheduler, promotions, clock } = harness()

    scheduler.offer(line('a', '我'), null)
    clock.advance(1000)
    scheduler.offer(line('a', '我看看'), null)
    scheduler.settled('a')
    clock.advance(5000)

    expect(promotions).toEqual([])
    expect(scheduler.shown().text).toBe('我看看')
  })

  it('又有新字时「已经到位」作废：不然后来那句会被当成早就划完了', () => {
    const { scheduler, promotions, clock } = harness()

    scheduler.settled('a')
    clock.advance(MIN_VISIBLE_MS)
    /* 旧句继续长字：还没到位。 */
    scheduler.offer(line('a', '我看看再说'), null)
    clock.advance(MIN_VISIBLE_MS)
    scheduler.offer(line('b', '下一句'), null)

    /* 得等它重新报到 settled 才会算「说完」，那之前靠等待上限兜底。 */
    clock.advance(MAX_WAIT_MS)

    expect(promotions).toHaveLength(1)
    expect(promotions[0]?.fast).toBe(true)
  })
})

describe('什么时候换句', () => {
  it('旧句已到位且露面超过 450ms：再过 250ms 换，不是快速刷', () => {
    const { scheduler, promotions, clock } = harness()

    clock.advance(100)
    scheduler.settled('a')
    clock.advance(MIN_VISIBLE_MS - 100)
    scheduler.offer(line('b'), null)

    /* 此刻恰是「露面满 450ms」，还要再等到位后的 250ms。 */
    clock.advance(END_HOLD_MS)

    expect(promotions).toEqual([{ snapshot: line('b'), fast: false }])
  })

  it('旧句一直没到位：等不满 MAX_WAIT_MS 就不换', () => {
    const { scheduler, promotions, clock } = harness()

    scheduler.offer(line('b'), null)
    clock.advance(MAX_WAIT_MS - 1)

    expect(promotions).toEqual([])

    clock.advance(1)

    expect(promotions).toHaveLength(1)
    expect(promotions[0]?.fast).toBe(true)
  })

  it('刚提升 100ms 就到位：也要等露满 450ms 才换下一句', () => {
    const { scheduler, promotions, clock } = harness()

    scheduler.settled('a')
    clock.advance(MIN_VISIBLE_MS)
    scheduler.offer(line('b'), null)
    clock.advance(END_HOLD_MS)

    expect(promotions).toHaveLength(1)

    /* b 刚上场 100ms 就说划到位了。 */
    clock.advance(100)
    scheduler.settled('b')
    scheduler.offer(line('c'), null)

    /* 450ms 之前不许换。 */
    clock.advance(MIN_VISIBLE_MS - 100 - END_HOLD_MS - 1)

    expect(promotions).toHaveLength(1)

    clock.advance(END_HOLD_MS + 1)

    expect(promotions).toHaveLength(2)
    expect(promotions[1]?.snapshot).toEqual(line('c'))
  })

  it('等待中又来两句：只提升最后一句，中间那句从不出现', () => {
    const { scheduler, promotions, clock } = harness()

    scheduler.offer(line('b'), null)
    clock.advance(100)
    scheduler.offer(line('c'), null)
    clock.advance(100)
    scheduler.offer(line('d'), null)
    clock.advance(MAX_WAIT_MS)

    expect(promotions).toHaveLength(1)
    expect(promotions[0]?.snapshot).toEqual(line('d'))
    expect(promotions[0]?.fast).toBe(true)
    expect(promotions.some((promotion) => promotion.snapshot.key === 'c')).toBe(false)
  })

  it('等待中同一句又长了几个字：只更新文字，不把等待的时钟重置', () => {
    const { scheduler, promotions, clock } = harness()

    /* 旧句一直没到位，于是下一句只能等到上限。 */
    scheduler.offer(line('b', '下'), null)
    clock.advance(MAX_WAIT_MS - 1)
    /* 等待期间这句自己又长了：起点不该因此往后挪，否则一直长字的句子永远等不到头。 */
    scheduler.offer(line('b', '下一句'), null)
    clock.advance(1)

    expect(promotions).toEqual([{ snapshot: line('b', '下一句'), fast: true }])
  })
})

describe('旧句的收尾', () => {
  it('previous.key 对得上就把旧句文字补完：同一批 token 里旧句的最后几个字', () => {
    const { scheduler, promotions, clock } = harness()

    scheduler.offer(line('a', '我先看看'), null)
    /* 旧句在这一批里才收尾，新句也在这批里开了头。 */
    scheduler.offer(line('b', '然后'), line('a', '我先看看这个文件。'))
    clock.advance(MAX_WAIT_MS)

    expect(promotions[0]?.snapshot).toEqual(line('b', '然后'))
    /* 补完发生在退场前：容器里退场的那一句因此是完整的那句。 */
    expect(scheduler.shown().text).toBe('然后')
  })

  it('previous 与当前显示的不是同一句时不动它', () => {
    const { scheduler, clock } = harness()

    scheduler.offer(line('b'), line('zzz', '另一句'))
    clock.advance(MAX_WAIT_MS)

    expect(scheduler.shown()).toEqual(line('b'))
  })

  /*
   * 旧代码上失败：那时只要 key 对得上就整句换成 previous，比手上这句短也照换。屏幕上于是
   * 出现「印出来的字被抹掉」—— 同一批里已经按更长的旧句渲染过一轮时就会撞上。
   */
  it('previous 比手上的还短就不换：补完只许往前，不许把印出来的字抹掉', () => {
    const { scheduler } = harness()

    /* 这一批里旧句先长到这里，容器因此已经按它渲染过一轮。 */
    scheduler.offer(line('a', '我先看看整个文件再动手'))
    /* 同一批里后面又送来一份更短的旧句快照（新句已经开头的那个版本）。 */
    scheduler.offer(line('b', '然后'), line('a', '我先看看'))

    expect(scheduler.shown()).toEqual(line('a', '我先看看整个文件再动手'))
  })
})

describe('减少动态效果', () => {
  it('新句立即提升，fast 恒为假', () => {
    const { scheduler, promotions } = harness(true)

    scheduler.offer(line('b'), null)
    scheduler.offer(line('c'), null)

    expect(promotions.map((promotion) => promotion.snapshot.key)).toEqual(['b', 'c'])
    expect(promotions.every((promotion) => !promotion.fast)).toBe(true)
  })
})

describe('删除路径', () => {
  it('dispose 之后推进时钟不再有回调', () => {
    const { scheduler, promotions, clock } = harness()

    scheduler.offer(line('b'), null)
    scheduler.dispose()
    clock.advance(MAX_WAIT_MS * 4)

    expect(promotions).toEqual([])
    expect(clock.pendingTimers()).toBe(0)
  })

  it('同一时刻只留一个计时器，返回值推进不会堆积', () => {
    const { scheduler, clock } = harness()

    scheduler.settled('a')

    for (let i = 0; i < 20; i += 1) {
      scheduler.offer(line(`b${String(i)}`), null)
      clock.advance(10)
    }

    expect(clock.pendingTimers()).toBeLessThanOrEqual(1)
  })
})
