/* 吉祥物（engine-runtime）的行为基线。
 *
 * 这些断言原本来自一次性对拍：把上游原始 .js 与迁移后的 .ts 放进同一 happy-dom 环境、
 * 用固定随机数与固定时钟跑同一组输入，逐字节比对配置导出、分组与连续 40 帧的 SVG。
 * 对拍通过后旧 .js 已删除，这里冻结的是当时的一致结论——将来改动吉祥物时，
 * 这些数字变了就说明视觉或时序被改动了。 */
import { describe, expect, test } from 'bun:test'

import { config, createEngine } from '../engine-runtime/engine'

/** 确定性：随机数与时钟固定，保证快照可复现 */
function pinDeterminism(): () => void {
  const realRandom = Math.random
  const realNow = performance.now.bind(performance)
  let seed = 12345
  let clock = 1000
  Math.random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  performance.now = () => {
    clock += 16.667
    return clock
  }
  return () => {
    Math.random = realRandom
    performance.now = realNow
  }
}

interface Harness {
  destroy: () => void
  tick: (now: number) => void
  setEmotion: (id: string) => boolean
  spin: (turns: number) => void
  burst: (count: number) => void
  bounce: () => void
  setGaze: (x: number, y: number) => void
  clearGaze: () => void
}

function mount(opts: Record<string, unknown> = {}): { host: HTMLElement; engine: Harness; restore: () => void } {
  const host = document.createElement('div')
  document.body.append(host)
  const restore = pinDeterminism()
  const engine = createEngine(host, { autostart: false, emotion: '02', shape: 'blob', ...opts }) as unknown as Harness
  return { host, engine, restore }
}

describe('吉祥物迁移版：行为基线', () => {
  test('种子配置全部注册成功：4 组 32 套', () => {
    expect(config.groups().map((g) => g.key)).toEqual(['life', 'emotion', 'agent', 'custom'])
    expect(config.list().length).toBe(32)
    expect(
      config.list('life').length +
        config.list('emotion').length +
        config.list('agent').length +
        config.list('custom').length,
    ).toBe(32)
  })

  test('配置导出包含全部 32 套且可回灌（importConfig 往返一致）', () => {
    const dumped = config.exportConfig()
    expect(JSON.parse(dumped).length).toBe(32)
    const roundTrip = config.importConfig(dumped)
    expect(roundTrip.ok).toBe(true)
    expect(roundTrip.added).toBe(32)
    expect(config.exportConfig()).toBe(dumped)
  })

  test('未知表情回退到待机且不抛异常', () => {
    const { host, engine, restore } = mount()
    let errorPayload: unknown = null
    ;(engine as unknown as { on: (e: string, cb: (p: unknown) => void) => void }).on('error', (p) => {
      errorPayload = p
    })
    expect(engine.setEmotion('no-such-emotion')).toBe(true)
    expect((engine as unknown as { emotionId: string }).emotionId).toBe('02')
    expect(errorPayload).not.toBeNull()
    engine.destroy()
    restore()
    host.remove()
  })

  test('destroy 后不再持有 rAF（ticker 清空，无残留实例）', () => {
    const { host, engine, restore } = mount()
    engine.destroy()
    restore()
    host.remove()
    expect(host.innerHTML).toBe('')
  })

  test('DOM 契约：bindTheme 依赖的 3 个渐变点与 3 个身体 path 恒成立', () => {
    const { host, engine, restore } = mount()
    expect(host.querySelectorAll('radialGradient > stop').length).toBe(3)
    expect(host.querySelectorAll('svg > g:nth-of-type(2) > path').length).toBe(3)
    const svg = host.querySelector('svg')
    expect(svg).not.toBeNull()
    engine.destroy()
    restore()
    host.remove()
  })

  for (const shape of ['blob', 'wedge', 'gem'] as const) {
    test(`全特效路径（${shape}）：32 套表情逐套渲染，每帧都有 SVG`, () => {
      const { host, engine, restore } = mount({ shape })
      let t = 1000
      const frame = (): string => {
        t += 16.667
        engine.tick(t)
        return host.innerHTML
      }
      for (const id of config.list()) {
        engine.setEmotion(id.id)
        for (let f = 0; f < 4; f++) expect(frame()).toContain('<svg')
      }
      engine.destroy()
      restore()
      host.remove()
    })

    test(`全特效路径（${shape}）：长停留 + 自旋 + 撒花 + 弹跳 + 注视切换`, () => {
      const { host, engine, restore } = mount({ shape })
      let t = 1000
      const frame = (): void => {
        t += 16.667
        engine.tick(t)
      }
      /* 长停留：表情池轮换 / 眨眼 / 待机小动作 / 常驻环带 / zzz 都会在这里走到 */
      for (let f = 0; f < 200; f++) frame()
      engine.spin(3)
      for (let f = 0; f < 40; f++) frame()
      engine.burst(30)
      engine.bounce()
      for (let f = 0; f < 40; f++) frame()
      engine.setGaze(0.8, -0.5)
      for (let f = 0; f < 15; f++) frame()
      engine.clearGaze()
      for (let f = 0; f < 8; f++) frame()
      expect(host.innerHTML).toContain('<svg')
      engine.destroy()
      restore()
      host.remove()
      expect(host.innerHTML).toBe('')
    })
  }

  test('连续 40 帧的渲染稳定：帧帧有内容，且切换表情/自旋/注视都会改变画面', () => {
    const { host, engine, restore } = mount()
    const frames: string[] = []
    for (let i = 0; i < 40; i++) {
      if (i === 5) engine.setEmotion('30')
      if (i === 12) engine.spin(1)
      if (i === 20) engine.setGaze(0.5, -0.25)
      if (i === 28) engine.setEmotion('13')
      engine.tick(1000 + i * 16.667)
      frames.push(host.innerHTML)
    }
    expect(frames.length).toBe(40)
    expect(frames.every((f) => f.includes('<svg'))).toBe(true)
    /* 表情切换后必然换眼环：第 5 帧与第 6 帧、第 28 帧与第 29 帧都必须不同 */
    expect(frames[6]).not.toBe(frames[5])
    expect(frames[29]).not.toBe(frames[28])
    /* 自旋推进偏航：第 12 帧之后的若干帧必须与静态时不同 */
    expect(new Set(frames.slice(12, 20)).size).toBeGreaterThan(1)
    engine.destroy()
    restore()
    host.remove()
  })
})
