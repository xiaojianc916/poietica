import { describe, expect, it } from 'vitest'
import { EXPRESSIONS } from '../surface/mascot/expressions'

/*
 * 表情是手抄进类型化模块的几何数据，引擎按「两环、每环 48 点」的固定
 * 形状插值 —— 形状一旦不齐，变形要到运行期才以 NaN 的样子露头。
 * 这里把契约钉住。
 */

describe('mascot expressions', () => {
  it('每张表情两只眼，每环 48 个有限坐标点', () => {
    expect(EXPRESSIONS.length).toBe(25)

    for (const expression of EXPRESSIONS) {
      expect(expression.length).toBe(2)

      for (const ring of expression) {
        expect(ring.length).toBe(48)

        for (const point of ring) {
          expect(Number.isFinite(point[0])).toBe(true)
          expect(Number.isFinite(point[1])).toBe(true)
        }
      }
    }
  })
})
