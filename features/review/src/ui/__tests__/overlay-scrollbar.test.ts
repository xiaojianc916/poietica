import { describe, expect, test } from 'bun:test'
import { thumbOf } from '../review-pane'

/*
 * 覆盖式滚动条的滑块几何。
 *
 * 换算错了屏幕上就是「滑块长度不对、拖到底内容没到底」，而这几种错都看不出来 —— 所以把
 * thumbOf 从组件里交出来单测。真机观感（盖在内容上、不占宽度）由 `bun run dev` 看一眼。
 */

describe('覆盖式滚动条的滑块几何', () => {
  test('滚不动时不画条', () => {
    expect(thumbOf(600, 600, 0).visible).toBe(false)
    expect(thumbOf(600, 400, 0).visible).toBe(false)
  })

  test('滑块长度按可视比走：内容三倍高 → 滑块约占三分之一', () => {
    expect(thumbOf(600, 1800, 0).height).toBeCloseTo(200, 5)
    expect(thumbOf(600, 6000, 0).height).toBeCloseTo(60, 5)
  })

  test('内容极长时滑块不短于 32px，否则抓不住', () => {
    expect(thumbOf(600, 100_000, 0).height).toBe(32)
  })

  test('滚到顶滑块贴顶，滚到底贴底且不越过容器', () => {
    expect(thumbOf(600, 1800, 0).offset).toBe(0)
    const height = thumbOf(600, 1800, 0).height
    expect(thumbOf(600, 1800, 1200).offset).toBeCloseTo(600 - height, 5)
  })

  test('滑块位移不超过可走距离', () => {
    for (const top of [0, 300, 1200]) {
      const held = thumbOf(600, 1800, top)
      expect(held.offset).toBeGreaterThanOrEqual(0)
      expect(held.offset).toBeLessThanOrEqual(600 - held.height + 1e-9)
    }
  })
})
