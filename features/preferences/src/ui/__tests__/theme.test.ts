import { describe, expect, test } from 'bun:test'
import { resolveStartupTheme, systemPrefersDark } from '../theme'

/*
 * 真实故障：用户在设置里选「深色」，冷启动后界面仍是浅色（跟随系统那一档），
 * 要回外观页再点一次才刷新。
 *
 * 根因是首帧没有任何东西把偏好投影到文档根：`theme.changed` 只在偏好变化与系统深浅
 * 变化时发，而 index.html 上写死 `data-theme="light"`。这条用例钉住「偏好 → 档位」
 * 这一步的判据（投影与订阅那一半在 index.tsx 里）。
 */
describe('启动时的主题档位', () => {
  test('明确选浅色 / 深色时直接用，不看系统', () => {
    expect(resolveStartupTheme('light', true)).toBe('light')
    expect(resolveStartupTheme('dark', false)).toBe('dark')
  })

  test('选跟随系统时读系统此刻那一档', () => {
    expect(resolveStartupTheme('system', true)).toBe('dark')
    expect(resolveStartupTheme('system', false)).toBe('light')
  })

  test('systemPrefersDark 在测试环境里可读（happy-dom 提供 matchMedia）', () => {
    expect(typeof systemPrefersDark()).toBe('boolean')
  })
})
