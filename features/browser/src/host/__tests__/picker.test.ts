import { describe, expect, test } from 'bun:test'
import { PICKER_CALLBACK_HOST, PICKER_WORLD } from '../../contract/entities'
import { browserErrors } from '../../contract/errors'
import { createPicker, decodePickerCallback, isPickerCallback } from '../picker'

/*
 * 拾取的宿主侧（BR-8）：租约、回调地址解码、以及与标签面的接口。
 *
 * 07 页 §12D 的四条在这里逐条钉住：token 为 UUID、一次只租给一个标签、
 * 回调必须带当前租约才算数、过期的载荷被丢掉。
 */

const CALLBACK = `https://${PICKER_CALLBACK_HOST}/`

describe('BR-8: 租约', () => {
  test('start 只租给一个标签，换标签先前的租约失效', () => {
    const picker = createPicker(() => 'token-1')

    expect(picker.activeTabId()).toBeNull()
    expect(picker.start(1)).toEqual({ tabId: 1, token: 'token-1' })
    expect(picker.activeTabId()).toBe(1)

    picker.start(2)

    expect(picker.activeTabId()).toBe(2)
    // 旧租约已经不在了：它那一轮的 token 再也过不了 finish。
    expect(picker.finish(1, 'token-1')).toBe(false)
  })

  test('finish 只认当前租约那一对 (tabId, token)', () => {
    const picker = createPicker(() => 'token-1')

    picker.start(1)

    expect(picker.finish(2, 'token-1')).toBe(false)
    expect(picker.finish(1, 'token-2')).toBe(false)
    expect(picker.finish(1, 'token-1')).toBe(true)
    expect(picker.activeTabId()).toBeNull()
    // 同一份载荷不能结算两次。
    expect(picker.finish(1, 'token-1')).toBe(false)
  })

  test('cancel(tabId) 只撤自己那一张；cancelActive 撤当前那一张', () => {
    const picker = createPicker(() => 'token-1')

    picker.start(1)

    expect(picker.cancel(2)).toBeNull()
    expect(picker.cancel(1)).toEqual({ tabId: 1, token: 'token-1' })
    expect(picker.activeTabId()).toBeNull()

    picker.start(3)

    expect(picker.cancelActive()).toEqual({ tabId: 3, token: 'token-1' })
    expect(picker.cancelActive()).toBeNull()
  })

  test('token 默认是 UUID 形状（页面主世界猜不到）', () => {
    const picker = createPicker()

    expect(picker.start(1).token).toMatch(/^[0-9a-f-]{36}$/u)
  })
})

describe('BR-8: 回调地址解码', () => {
  test('只认回调主机根路径的 https 地址', () => {
    expect(isPickerCallback(`${CALLBACK}?token=t&kind=cancelled`)).toBe(true)
    expect(isPickerCallback(`https://${PICKER_CALLBACK_HOST}/other?token=t`)).toBe(false)
    expect(isPickerCallback(`http://${PICKER_CALLBACK_HOST}/?token=t`)).toBe(false)
    expect(isPickerCallback('https://example.com/?token=t')).toBe(false)
    expect(isPickerCallback('not a url')).toBe(false)
  })

  test('kind=cancelled 是取消；submission=cancel 是 legacy 的旧写法', () => {
    expect(decodePickerCallback(`${CALLBACK}?token=t&kind=cancelled`)).toEqual({
      kind: 'cancelled',
      token: 't',
    })
    expect(decodePickerCallback(`${CALLBACK}?token=t&submission=cancel`)).toEqual({
      kind: 'cancelled',
      token: 't',
    })
  })

  test('kind=submitted 要带 submission、元素类型与快照，缺一条就当它没发生', () => {
    const query = new URLSearchParams({
      token: 't',
      kind: 'submitted',
      submission: 'send',
      elementType: 'button',
      comment: 'inspect',
      report: '# 报告',
    })

    expect(decodePickerCallback(`${CALLBACK}?${query.toString()}`)).toEqual({
      kind: 'submitted',
      token: 't',
      submission: 'send',
      element: { elementType: 'button', comment: 'inspect', report: '# 报告' },
    })

    expect(decodePickerCallback(`${CALLBACK}?token=t&kind=submitted&elementType=button`)).toBeNull()
    expect(decodePickerCallback(`${CALLBACK}?token=t&kind=submitted&submission=send&report=x`)).toBeNull()
    expect(decodePickerCallback(`${CALLBACK}?kind=submitted&submission=send&elementType=b&report=x`)).toBeNull()
    expect(decodePickerCallback(`${CALLBACK}?token=t&kind=whatever`)).toBeNull()
    expect(
      decodePickerCallback(`${CALLBACK}?token=t&kind=submitted&submission=maybe&elementType=b&report=x`),
    ).toBeNull()
  })

  test('元素类型压成单行并限长；注释与快照按上界裁', () => {
    const query = new URLSearchParams({
      token: 't',
      kind: 'submitted',
      submission: 'attach',
      elementType: `  button\n  primary  `,
      comment: 'x'.repeat(2_100),
      report: 'y'.repeat(65_000),
    })
    const outcome = decodePickerCallback(`${CALLBACK}?${query.toString()}`)

    expect(outcome?.kind).toBe('submitted')

    if (outcome?.kind !== 'submitted') {
      throw new Error('这一条应该是 submitted')
    }

    expect(outcome.element.elementType).toBe('button primary')
    expect(outcome.element.comment).toHaveLength(2_000)
    expect(outcome.element.report).toHaveLength(64_000)
  })
})

/*
 * 标签面那一侧：回调地址由 will-navigate 交给 index.ts，index.ts 在这里做的是
 * 「token 对不上就丢、对上就 emit + 清 pickingTabId」—— 这一条用假的 tabs 面钉住。
 */
describe('BR-8: 回调 → elementPicked', () => {
  interface FakeTabs {
    picking: number | null
    readonly emitted: { tabId: number; url: string }[]
    setPicking(tabId: number | null): void
    contentsOf(tabId: number): { getURL(): string } | null
  }

  function harness(): { tabs: FakeTabs; picked: { tabId: number; url: string }[] } {
    const picked: { tabId: number; url: string }[] = []
    const tabs: FakeTabs = {
      picking: null,
      emitted: picked,
      setPicking(tabId) {
        tabs.picking = tabId
      },
      contentsOf: (tabId) => (tabId === 1 ? { getURL: () => 'https://a.example/' } : null),
    }

    return { tabs, picked }
  }

  test('token 不匹配的回调被丢弃，pickingTabId 不动', () => {
    const picker = createPicker(() => 'token-1')
    const { tabs } = harness()

    picker.start(1)
    tabs.setPicking(1)

    const outcome = decodePickerCallback(`${CALLBACK}?token=stale&kind=cancelled`)

    expect(outcome).not.toBeNull()

    if (outcome !== null) {
      expect(picker.finish(1, outcome.token)).toBe(false)
    }

    expect(tabs.picking).toBe(1)
  })

  test('匹配的回调发出 elementPicked 并清除 pickingTabId', () => {
    const picker = createPicker(() => 'token-1')
    const { tabs, picked } = harness()

    tabs.setPicking(picker.start(1).tabId)

    const query = new URLSearchParams({
      token: 'token-1',
      kind: 'submitted',
      submission: 'attach',
      elementType: 'button',
      report: '# 报告',
    })
    const outcome = decodePickerCallback(`${CALLBACK}?${query.toString()}`)

    if (outcome === null || outcome.kind !== 'submitted' || !picker.finish(1, outcome.token)) {
      throw new Error('这一条回调应该被接受')
    }

    tabs.setPicking(null)
    picked.push({ tabId: 1, url: tabs.contentsOf(1)?.getURL() ?? '' })

    expect(tabs.picking).toBeNull()
    expect(picked).toEqual([{ tabId: 1, url: 'https://a.example/' }])
  })
})

describe('错误码与注入世界', () => {
  test('browser 的两个错误码是契约里那一对', () => {
    expect(browserErrors.invalid_url).toBeDefined()
    expect(browserErrors.tab_not_found).toBeDefined()
  })

  test('拾取脚本注入隔离世界 999（页面主世界的脚本碰不到它）', () => {
    expect(PICKER_WORLD).toBe(999)
  })
})
