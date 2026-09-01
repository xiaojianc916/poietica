import { describe, expect, test } from 'bun:test'
import { goalBarPresentation } from '../goal/goal-bar'

describe('goal bar presentation', () => {
  test('matches the visible DeepSeek Harness phase vocabulary and controls', () => {
    expect(goalBarPresentation('active')).toEqual({ label: '进行中的目标', toggle: 'pause' })
    expect(goalBarPresentation('paused')).toEqual({ label: '已暂停的目标', toggle: 'resume' })
    expect(goalBarPresentation('blocked')).toEqual({ label: '受阻的目标', toggle: null })
  })

  test('does not keep completed work in composer chrome', () => {
    expect(goalBarPresentation('complete')).toBeNull()
  })
})
