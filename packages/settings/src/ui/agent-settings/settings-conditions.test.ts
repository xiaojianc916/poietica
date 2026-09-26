import { describe, expect, it } from 'bun:test'
import type { AgentSettingEntry } from '../../index'
import { isVisible, settingLookup } from './settings-conditions'

/*
 * 条件求值这一层。
 *
 * 条件的**名字**来自 agent 自己那份 schema（桥只搬名字，ADR 0054 决定四）；名字到判据的
 * 对应抄自上游 `src/config/settings-ui.ts` 的 `CONDITIONS`（锚定 18.3.0），逐条：
 * advisorEnabled→advisor.enabled、mnemopiActive/hindsightActive→memory.backend、
 * autolearnActive→autolearn.enabled、autoThinkingActive→defaultThinkingLevel、
 * usageAwareFallbackEnabled→retry.usageAwareFallback、vimModeEnabled→tui.vimMode、
 * planModeEnabled/planAutosaveEnabled→plan.enabled + plan.autosave、macOS→宿主平台。
 *
 * 这一条测试守两个方向：
 * - 认得出的按**目录里此刻的值**算（值从哪来由 settingLookup 一处决定）；
 * - 认不出的（上游将来加的名字，或我们够不着的 `hasImageProtocol`）一律不显示 ——
 *   少显示一格人看得出，多显示一格人看不出。
 *
 * 「上游此刻用到哪些名字」由 packages/agent-bridge 那侧对着真 schema 守着（它才看得见 omp，
 * 本包看不见也不该看见：layering 不允许）。
 */

function entry(overrides: Partial<AgentSettingEntry> = {}): AgentSettingEntry {
  return {
    path: 'sample.path',
    type: 'boolean',
    label: 'Sample',
    description: '',
    tab: 'tools',
    default: null,
    value: null,
    secret: false,
    hasValue: false,
    ...overrides,
  }
}

function at(values: Record<string, unknown>) {
  return settingLookup(Object.entries(values).map(([path, value]) => entry({ path, value })))
}

/** 条件名到「让它成立的那一份设置」。 */
const SATISFYING: readonly (readonly [string, Record<string, unknown>])[] = [
  ['advisorEnabled', { 'advisor.enabled': true }],
  ['vimModeEnabled', { 'tui.vimMode': true }],
  ['autolearnActive', { 'autolearn.enabled': true }],
  ['usageAwareFallbackEnabled', { 'retry.usageAwareFallback': true }],
  ['planModeEnabled', { 'plan.enabled': true }],
  ['planAutosaveEnabled', { 'plan.autosave': true, 'plan.enabled': true }],
  ['mnemopiActive', { 'memory.backend': 'mnemopi' }],
  ['hindsightActive', { 'memory.backend': 'hindsight' }],
  ['autoThinkingActive', { defaultThinkingLevel: 'auto' }],
]

describe('条件的求值', () => {
  it('没有条件就是显示', () => {
    expect(isVisible(entry(), at({}))).toBe(true)
  })

  it('认不出的条件不显示：不知道就不画，不猜一个默认值', () => {
    expect(isVisible(entry({ condition: 'inventedBySomeFutureVersion' }), at({}))).toBe(false)
  })

  it('认得出的条件在设置成立时显示', () => {
    for (const [condition, values] of SATISFYING) {
      expect([condition, isVisible(entry({ condition }), at(values))]).toEqual([condition, true])
    }
  })

  it('认得出的条件在设置不成立时不显示', () => {
    for (const [condition] of SATISFYING) {
      expect([condition, isVisible(entry({ condition }), at({}))]).toEqual([condition, false])
    }
  })

  it('取值判据不是真值判据：memory.backend 换成别的后端就换一栏', () => {
    const mnemopi = entry({ condition: 'mnemopiActive' })
    const hindsight = entry({ condition: 'hindsightActive' })

    expect(isVisible(mnemopi, at({ 'memory.backend': 'mnemopi' }))).toBe(true)
    expect(isVisible(mnemopi, at({ 'memory.backend': 'hindsight' }))).toBe(false)
    expect(isVisible(hindsight, at({ 'memory.backend': 'hindsight' }))).toBe(true)
    expect(isVisible(hindsight, at({ 'memory.backend': 'mnemopi' }))).toBe(false)
  })

  it('planAutosaveEnabled 要两格同时成立，不是只看一格', () => {
    const subject = entry({ condition: 'planAutosaveEnabled' })

    expect(isVisible(subject, at({ 'plan.autosave': true, 'plan.enabled': true }))).toBe(true)
    expect(isVisible(subject, at({ 'plan.autosave': true }))).toBe(false)
    expect(isVisible(subject, at({ 'plan.enabled': true }))).toBe(false)
  })

  it('autoThinkingActive 认的是 auto 这个取值', () => {
    const subject = entry({ condition: 'autoThinkingActive' })

    expect(isVisible(subject, at({ defaultThinkingLevel: 'auto' }))).toBe(true)
    expect(isVisible(subject, at({ defaultThinkingLevel: 'high' }))).toBe(false)
  })

  /*
   * `hasImageProtocol` 刻意不认：上游问的是**终端**能不能显示图片（`TERMINAL.imageProtocol`），
   * 我们这个宿主不是终端，这个问题在这里没有答案。编一个答案就是把「画不出来」说成「画得对」。
   */
  it('hasImageProtocol 不猜：宿主不是终端，这一问在我们这里没有答案', () => {
    expect(isVisible(entry({ condition: 'hasImageProtocol' }), at({}))).toBe(false)
  })

  /*
   * `macOS` 认得出但取决于宿主平台。断言的判据是「与 navigator 自己报的一致」，不是
   * 与 `process.platform` 一致 —— 后者在这个 webview 里根本不存在。
   */
  it('macOS 跟着宿主自己报的平台走', () => {
    const expected =
      typeof navigator === 'undefined' ? false : /Mac|iPhone|iPad/u.test(navigator.userAgent)

    expect(isVisible(entry({ condition: 'macOS' }), at({}))).toBe(expected)
  })

  it('值只从目录里来：同一格在目录里改成别的值，可见性跟着变', () => {
    const subject = entry({ condition: 'advisorEnabled' })

    expect(
      isVisible(subject, settingLookup([entry({ path: 'advisor.enabled', value: true })])),
    ).toBe(true)
    expect(
      isVisible(subject, settingLookup([entry({ path: 'advisor.enabled', value: false })])),
    ).toBe(false)
  })
})
