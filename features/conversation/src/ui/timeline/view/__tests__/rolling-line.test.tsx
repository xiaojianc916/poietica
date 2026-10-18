import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import { type ReactElement, StrictMode } from 'react'
import { RollingLine } from '../ticker/rolling-line'

/* happy-dom 没有布局（宽度恒 0、ResizeObserver 不回调），量不出「滚到哪、裁没裁到字」—— 那归 ticker-pace / ticker-glide 的纯函数测与 ticker-layout 的真实布局检查；
 * 这里只测格子选择、放字顺序、换句后旧句残留、有没有「遮」的记号。上下刷走 MotionConfig skipAnimations。 */

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await wait(ms)
  })
}

interface Mounted {
  readonly container: HTMLElement
  readonly update: (node: ReactElement) => Promise<void>
}

function mount(node: ReactElement): Mounted {
  const { container, rerender } = render(<MotionConfig skipAnimations>{node}</MotionConfig>)

  return {
    container,
    update: async (next) => {
      await act(async () => {
        rerender(<MotionConfig skipAnimations>{next}</MotionConfig>)
      })
    },
  }
}

const thought = (contentKey: string, text: string, previous: { key: string; text: string } | null = null) => (
  <RollingLine contentKey={contentKey} following previous={previous} text={text} variant="thought" />
)

/** 每隔 step 毫秒记一次 textContent，记 total 毫秒。 */
async function sample(container: HTMLElement, total: number, step = 20): Promise<string[]> {
  const seen: string[] = []

  for (let elapsed = 0; elapsed < total; elapsed += step) {
    await advance(step)
    seen.push(container.textContent ?? '')
  }

  return seen
}

afterEach(() => {
  cleanup()
})

describe('思考句（还在写）', () => {
  it('首次挂载：整句直接摆好，不从第一个字重播', () => {
    const { container } = mount(thought('0', '我需要确认 relay 的端口'))

    expect(container.querySelector('.ticker-window > .ticker-track')).not.toBeNull()
    expect(container.textContent).toBe('我需要确认 relay 的端口')
  })

  it('同一句继续长：按顺序放字，屏幕上永远是全文的前缀，停笔后写全', async () => {
    const full = '我需要确认 relay 的端口，再看配置文件里写的是哪一个'
    const { container, update } = mount(thought('0', '我'))
    const seen: string[] = []

    for (let end = 4; end < full.length; end += 4) {
      await update(thought('0', full.slice(0, end)))
      seen.push(...(await sample(container, 60)))
    }
    await update(thought('0', full))
    await advance(1500)

    for (const text of seen) expect(full.startsWith(text)).toBe(true)
    expect(container.textContent).toBe(full)
  })

  it('成批到达时不是一批一下：一批字切成几段、错开起淡（与回复正文同一个 planWave）', async () => {
    const full = '先读一下 tooling 目录里的检查脚本，看它们怎么挂到 lint 上，再决定改哪一层'
    const { container, update } = mount(thought('0', full.slice(0, 2)))

    await update(thought('0', full))
    await advance(250)

    const starts = [...container.querySelectorAll<HTMLElement>('.ticker-track > span')].map(
      (node) => node.getAnimations()[0]?.startTime,
    )

    expect(starts.length).toBeGreaterThan(1)
    expect(new Set(starts).size).toBe(starts.length)
  })

  it('前面的字被改写（Markdown 记号闭合）：从改写处重放，最后没有错字', async () => {
    const { container, update } = mount(thought('0', '先看 **配置'))

    await update(thought('0', '先看 配置文件'))
    await advance(1500)

    expect(container.textContent).toBe('先看 配置文件')
  })

  it('新字与回复正文同一套：成段淡入（只动透明度），淡完并回正文；没有第二种颜色', async () => {
    const { container, update } = mount(thought('0', '我'))

    await update(thought('0', '我需要确认端口'))
    await advance(40)

    const fading = [...container.querySelectorAll<HTMLElement>('.ticker-track > span')]

    expect(fading.length).toBeGreaterThan(0)
    for (const node of fading) {
      expect(node.className).toBe('')
      expect(node.style.color).toBe('')
      expect(node.getAnimations()).toHaveLength(1)
    }

    await advance(1500)
    expect(container.querySelectorAll('.ticker-track > span')).toHaveLength(0)
    expect(container.textContent).toBe('我需要确认端口')
  })

  it('卸载：不留在跑的逐帧回调', async () => {
    const original = window.requestAnimationFrame.bind(window)
    let calls = 0

    window.requestAnimationFrame = (callback) => {
      calls += 1
      return original(callback)
    }

    try {
      const { update } = mount(thought('0', '我'))

      await update(thought('0', '我需要确认 relay 的端口，再看配置'))
      await advance(50)
      expect(calls).toBeGreaterThan(0)
      cleanup()

      const before = calls

      await wait(200)
      expect(calls).toBe(before)
    } finally {
      window.requestAnimationFrame = original
    }
  })
})

describe('不动的格子', () => {
  it('工具行：从头显示整句，不建引擎（没有淡入段、没有位移）', () => {
    const { container } = mount(<RollingLine contentKey="call-1" following shimmer text="读 config.ts" />)
    const track = container.querySelector<HTMLElement>('.ticker-track')

    expect(container.querySelector('.rolling-line')?.getAttribute('data-variant')).toBe('tool')
    expect(container.querySelector('.ticker-track > span')).toBeNull()
    expect(track?.textContent).toBe('读 config.ts')
    expect(track?.style.transform).toBe('')
  })

  it('落定的思考句：不滚、没有 data-following，整句从头显示', () => {
    const { container } = mount(
      <RollingLine contentKey="0" following={false} text="结论：端口是 8123" variant="thought" />,
    )

    expect(container.querySelector('.rolling-line')?.hasAttribute('data-following')).toBe(false)
    expect(container.querySelector('.ticker-track > span')).toBeNull()
    expect(container.querySelector('.ticker-track')?.textContent).toBe('结论：端口是 8123')
  })

  it('「正在思考」占位：戴扫光、不滚', () => {
    const { container } = mount(
      <RollingLine contentKey="placeholder" following shimmer text="正在思考" variant="thought" />,
    )

    expect(container.querySelector('.timeline-shimmer')).not.toBeNull()
    expect(container.querySelector('.ticker-track > span')).toBeNull()
  })
})

describe('换句', () => {
  it('新句出现：旧句先露面够久，再换成新句，新句从第一段淡起', async () => {
    const { container, update } = mount(thought('0', '第一句。'))

    await update(thought('5', '然后看配置文件', { key: '0', text: '第一句。' }))
    expect(container.textContent).toContain('第一句')

    /* 新句里已经落定（不在淡入段里）的那截：从第一个字淡起，就该见过「一个都没落定」的时刻 */
    const settled: string[] = []

    for (let elapsed = 0; elapsed < 2000; elapsed += 20) {
      await advance(20)

      const track = [...container.querySelectorAll('.ticker-track')].at(-1)
      const text = track?.textContent ?? ''

      if (text.includes('第一句')) continue

      const fading = [...(track?.querySelectorAll('span') ?? [])].map((node) => node.textContent ?? '').join('')

      settled.push(text.slice(0, text.length - fading.length))
    }

    expect(settled[0]).toBe('')
    for (const text of settled) expect('然后看配置文件'.startsWith(text)).toBe(true)
    expect(container.textContent).toBe('然后看配置文件')
  })

  it('等待期间又来更新的句子：直接换上最新那句，过期的那句不补播', async () => {
    const { container, update } = mount(thought('0', '第一句。'))

    await update(thought('5', '第二句。', { key: '0', text: '第一句。' }))
    await advance(60)
    await update(thought('10', '第三句', { key: '5', text: '第二句。' }))

    const seen = await sample(container, 2000)

    for (const text of seen) expect(text.includes('第二句')).toBe(false)
    expect(container.textContent).toBe('第三句')
  })
})

describe('StrictMode（开发时模拟一次卸载再挂回）', () => {
  it('只有一条轨道，换句照常发生', async () => {
    const wrap = (node: ReactElement) => (
      <StrictMode>
        <MotionConfig skipAnimations>{node}</MotionConfig>
      </StrictMode>
    )
    const { container, rerender } = render(wrap(thought('0', '第一句。')))

    expect(container.querySelectorAll('.ticker-track')).toHaveLength(1)

    await act(async () => {
      rerender(wrap(thought('5', '然后', { key: '0', text: '第一句。' })))
    })
    /* 分小步等：一个长 act 里 React 会把换句那次渲染攒到 act 结束才做 */
    await sample(container, 1600)

    expect(container.querySelectorAll('.ticker-track')).toHaveLength(1)
    expect(container.textContent).toBe('然后')
  })
})
