import { describe, expect, test } from 'bun:test'
import { resolveStartupTheme } from '../theme'

/* 真实故障：选「深色」冷启动后界面仍是浅色，要回外观页再点一次才刷新 —— 首帧没有任何东西把偏好投影到文档根。 */
describe('启动时的主题档位', () => {
  test('明确选浅色 / 深色时直接用，不看系统', () => {
    expect(resolveStartupTheme('light', true)).toBe('light')
    expect(resolveStartupTheme('dark', false)).toBe('dark')
  })

  test('选跟随系统时读系统此刻那一档', () => {
    expect(resolveStartupTheme('system', true)).toBe('dark')
    expect(resolveStartupTheme('system', false)).toBe('light')
  })
})
