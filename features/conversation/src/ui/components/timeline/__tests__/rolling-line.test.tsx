import { afterEach, describe, expect, it } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { MotionConfig } from 'motion/react'
import type { ReactElement } from 'react'
import { RollingLine } from '../rolling-line'

/*
 * 组头那一格的结构与接线。
 *
 * happy-dom 没有真实布局：宽度一律量成 0，所以「划了多远」「淡出落在哪」量不出来 —— 那些
 * 归 marquee-model 的纯函数测。这里测的是**结构与属性**：轨道在不在、墨迹尾巴有没有重复、
 * 换句之后旧句有没有留下、落定态有没有把「还在写」的记号撤掉。
 *
 * 两组用例各自按住一件事：
 *
 *   • **上下刷**走 `MotionConfig skipAnimations` —— 与 `composer-submit.test.tsx` 同一条
 *     理由：happy-dom 的 `Element.animate` 不推进时间轴，动画停在中途被取消时 motion 会
 *     reject 一个没人接的 `finished` promise，一条这样的 rejection 就足以拖垮后面的用例，
 *     真机上不会发生。`skipAnimations` 让动画整条不建，换句因此是「立刻到位」。
 *
 *   • **横向划动与墨迹**不受 motion 管：它们读的是真实时间轴，所以照常跑。
 *
 * 不去改系统偏好：它在 motion 内部首次读取时就缓存（useReducedMotion 的惰性初始化），同一个
 * 测试进程里再改已经晚了。
 *
 * 时序用真实等待：调度器与逐帧引擎读的是 `performance.now()` 和系统定时器，不认 fakeClock。
 * 等的是真时间，所以每一步都留够余量。
 */

function frame(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await frame(ms)
  })
}

interface Mounted {
  readonly container: HTMLElement
  /** 换一批 props：@testing-library 的 rerender 会把整棵树换成新的根，MotionConfig 那一层
      因此要一起换 —— 不然组件被重新挂载，墨迹与调度器里的账全丢，测出来的是假象。 */
  readonly update: (node: ReactElement) => void
}

/** 挂上一格。上下刷不建动画（立刻到位），横向划动与墨迹照常（见文件头注）。 */
function mount(node: ReactElement): Mounted {
  const { container, rerender } = render(<MotionConfig skipAnimations>{node}</MotionConfig>)

  return {
    container,
    update: (next) => {
      rerender(<MotionConfig skipAnimations>{next}</MotionConfig>)
    },
  }
}

afterEach(() => {
  cleanup()
})

describe('思考句的轨道', () => {
  it('渲染出轨道与窗口，窗口认这个 variant', () => {
    const { container } = mount(
      <RollingLine contentKey="0" following text="我需要确认 relay 的端口" variant="thought" />,
    )

    expect(container.querySelector('.ticker-window')).not.toBeNull()
    expect(container.querySelector('.ticker-track')).not.toBeNull()
    expect(container.querySelector('.rolling-line')?.getAttribute('data-variant')).toBe('thought')
  })

  it('连续追加文字时只有一个墨迹尾巴：新字并进同一条', async () => {
    const { container, update } = mount(<RollingLine contentKey="0" following text="我" variant="thought" />)

    for (const text of ['我需要', '我需要确认', '我需要确认 relay 的端口']) {
      await act(async () => {
        update(<RollingLine contentKey="0" following text={text} variant="thought" />)
      })

      expect(container.querySelectorAll('.ticker-ink')).toHaveLength(1)
      expect(container.textContent).toBe(text)
    }
  })

  it('工具行与落定态不开墨迹：颜色归扫光，也归安静色', () => {
    const tool = mount(<RollingLine contentKey="call-1" following shimmer text="读 config.ts" />)

    expect(tool.container.querySelectorAll('.ticker-ink')).toHaveLength(0)
    cleanup()

    const settledLine = mount(<RollingLine contentKey="0" following={false} text="结论" variant="thought" />)

    expect(settledLine.container.querySelectorAll('.ticker-ink')).toHaveLength(0)
  })
})

describe('换句', () => {
  it('换 contentKey 之后，最终 DOM 里只剩新句的文字', async () => {
    const { container, update } = mount(<RollingLine contentKey="0" following text="第一句。然后" variant="thought" />)

    await act(async () => {
      update(
        <RollingLine
          contentKey="5"
          following
          previous={{ key: '0', text: '第一句。' }}
          text="然后"
          variant="thought"
        />,
      )
    })

    /* 旧句要等调度器放行（旧句没划到位时最多等 1200ms），再等上下刷走完。 */
    await advance(1500)

    expect(container.textContent).toContain('然后')
    expect(container.textContent).not.toContain('第一句')
  })

  it('落定之后把「还在写」的记号撤掉：那时这句话是结论', async () => {
    const { container, update } = mount(
      <RollingLine contentKey="0" following text="一长串还没写完的字" variant="thought" />,
    )

    expect(container.querySelector('.rolling-line')?.hasAttribute('data-following')).toBe(true)

    await act(async () => {
      update(<RollingLine contentKey="0" following={false} text="一长串还没写完的字" variant="thought" />)
    })

    expect(container.querySelector('.rolling-line')?.hasAttribute('data-following')).toBe(false)
  })

  it('落定态不划：窗口上没有 data-scrolled', async () => {
    const { container } = mount(<RollingLine contentKey="0" following={false} text="结论" variant="thought" />)

    await advance(80)

    expect(container.querySelector('.ticker-window')?.hasAttribute('data-scrolled')).toBe(false)
  })
})

describe('不改变 DOM 契约', () => {
  it('容器只加一个 variant 属性，别名默认是工具行', () => {
    const { container } = mount(<RollingLine contentKey="k" following={false} text="摘要" />)
    const line = container.querySelector('.rolling-line')

    expect(line?.getAttribute('data-variant')).toBe('tool')
    expect(line?.hasAttribute('data-following')).toBe(false)
  })

  it('三种状态各自的 mode 落在一个属性上，样式与引擎都读它', () => {
    const followingThought = mount(<RollingLine contentKey="0" following text="在想" variant="thought" />)

    expect(followingThought.container.querySelector('.ticker-track')?.getAttribute('data-mode')).toBe('glide')
    cleanup()

    const runningTool = mount(<RollingLine contentKey="call-1" following text="读文件" />)

    expect(runningTool.container.querySelector('.ticker-track')?.getAttribute('data-mode')).toBe('tail')
    cleanup()

    const settled = mount(<RollingLine contentKey="k" following={false} text="摘要" variant="thought" />)

    expect(settled.container.querySelector('.ticker-track')?.getAttribute('data-mode')).toBe('start')
  })
})
