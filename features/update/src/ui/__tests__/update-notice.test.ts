import { describe, expect, test } from 'bun:test'
import { type UpdateState, UpdateState as UpdateStateSchema } from '../../contract'
import { updateBannerNotice, updateBannerVisible } from '../update-notice'

/*
 * 横幅三态（07 页 §15E）。判据是纯函数，所以这里钉的是**哪一刻该说什么、给哪几个动作**
 * ——「稍后」的作用域（本次运行、只对那一版）、下载中的进度与字形、待重启那唯一入口，
 * 全在这几条里。
 *
 * 横幅本身改回了 design-system 的通用 Banner（产品负责人 2026-10-06），但这一层判据
 * 一字未动：换的只是画在哪，不是说什么。
 */

const state = (over: Partial<UpdateState>): UpdateState =>
  UpdateStateSchema.parse({
    phase: 'idle',
    currentVersion: '0.5.0',
    version: null,
    notes: null,
    progress: null,
    error: null,
    lastCheckedAt: null,
    ...over,
  })

describe('available', () => {
  test('说版本号，给「下载」与「稍后」两个动作', () => {
    const notice = updateBannerNotice(state({ phase: 'available', version: '1.2.3' }), null)
    expect(notice?.text).toBe('发现新版本 v1.2.3')
    expect(notice?.actions).toEqual(['download', 'later'])
  })

  test('「稍后」只藏这一版；换一版横幅回来说', () => {
    expect(updateBannerNotice(state({ phase: 'available', version: '1.2.3' }), '1.2.3')).toBeNull()
    expect(updateBannerNotice(state({ phase: 'available', version: '1.2.4' }), '1.2.3')).not.toBeNull()
  })
})

describe('downloading', () => {
  test('有确数就写进句子并给轨，没有确数不假装在动', () => {
    const counted = updateBannerNotice(state({ phase: 'downloading', version: '1.2.3', progress: 0.5 }), null)
    expect(counted?.text).toContain('50%')
    expect(counted?.progress).toBe(0.5)

    const unknown = updateBannerNotice(state({ phase: 'downloading', version: '1.2.3', progress: null }), null)
    expect(unknown?.progress).toBeUndefined()
    expect(unknown?.text).toBe('正在下载 v1.2.3…')
  })

  test('正在动的那一档要一枚转着的字形，且不给「稍后」', () => {
    const notice = updateBannerNotice(state({ phase: 'downloading', version: '1.2.3', progress: 0 }), null)
    expect(notice?.spinning).toBe(true)
    expect(notice?.actions).toEqual([])
    /* 0 是合法的确数（刚开始），不能因为它是假值就被吞掉。 */
    expect(notice?.progress).toBe(0)
  })
})

describe('ready', () => {
  test('带唯一的安装入口', () => {
    const notice = updateBannerNotice(state({ phase: 'ready', version: '1.2.3', progress: 1 }), null)
    expect(notice?.text).toBe('新版本已下载')
    expect(notice?.actions).toEqual(['install'])
  })

  test('「稍后」管不到待重启：它带着唯一的入口，藏掉人就没法装了', () => {
    expect(updateBannerNotice(state({ phase: 'ready', version: '1.2.3' }), '1.2.3')).not.toBeNull()
  })
})

describe('不说话的那几档', () => {
  test('disabled / idle / checking / error 都没有话说', () => {
    for (const phase of ['disabled', 'idle', 'checking', 'error'] as const) {
      expect(updateBannerVisible(state({ phase }), null)).toBe(false)
    }
  })

  test('没有版本号就没有可说的对象', () => {
    expect(updateBannerVisible(state({ phase: 'downloading', version: null }), null)).toBe(false)
    expect(updateBannerVisible(null, null)).toBe(false)
  })
})

/*
 * 「已是最新」是**手动检查**的答复（legacy `update-phase.ts` 的 latest 档），不是 Host
 * 的一个相位：`idle` 分不出「没查过」与「查过、没有新版本」，所以这个标记由发起检查的
 * 那一侧记在 store 里，横幅只负责报，报完清掉。
 */
describe('latest（手动检查的回话）', () => {
  test('idle + latest：说「已是最新版本」，带绿勾、没有动作', () => {
    const notice = updateBannerNotice(state({ phase: 'idle' }), null, true)
    expect(notice?.text).toBe('已是最新版本')
    expect(notice?.tone).toBe('success')
    expect(notice?.actions).toEqual([])
  })

  test('没有 latest 标记时这一档不出现（自动检查保持安静）', () => {
    expect(updateBannerNotice(state({ phase: 'idle' }), null, false)).toBeNull()
    expect(updateBannerNotice(state({ phase: 'idle' }), null)).toBeNull()
  })

  test('发现新版本时 latest 标记不抢话：有版本号的相位优先', () => {
    const notice = updateBannerNotice(state({ phase: 'available', version: '1.2.3' }), null, true)
    expect(notice?.text).toBe('发现新版本 v1.2.3')
  })

  test('可见性判据与内容同源', () => {
    expect(updateBannerVisible(state({ phase: 'idle' }), null, true)).toBe(true)
    expect(updateBannerVisible(state({ phase: 'idle' }), null, false)).toBe(false)
  })
})
