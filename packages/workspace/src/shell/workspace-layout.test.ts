import { describe, expect, it } from 'bun:test'
import { WORKSPACE_LAYOUT } from './workspace-layout'

/*
 * 一份清单，两处断言。
 *
 * 这份像素令牌清单原先在两个测试里各手抄一遍，两遍都写着
 * WORKSPACE_LAYOUT.activityRail.width —— 那个令牌已经不在契约里（活动栏宽度由
 * CSS 自定义属性 --activity-rail-width 持有），于是同一处漂移报两次。抄两遍的
 * 代价还不止于此：sidebar.navIconCenter 这个真实的像素令牌从来没有被覆盖过，因为
 * 补充覆盖要改两个地方。
 *
 * sidebar.toggleZoneWidth 曾经也在这份清单里，现在不是契约的一部分了：标题栏开合区
 * 的宽度下限由中线与控件高在 desktop-title-bar.css 里算出（前导 × 2 + 控件高），
 * 右侧留白与左侧恒等。它此前手填 44px，而按同一条中线对称应得 48px——这份清单只断言
 * 它是正整数，所以那处不对称从来没有被任何断言拦住过。像素令牌进这份清单只说明它
 * 有限、为正、是整数；令牌之间的几何关系要断言，就得写成专门的等式。
 *
 * motion 不在清单里：它是秒与贝塞尔控制点，既非像素也非整数，由下面两个专门的
 * 测试覆盖。
 */
const PIXEL_DIMENSION_TOKENS: readonly number[] = [
  WORKSPACE_LAYOUT.sidebar.navIconCenter,
  WORKSPACE_LAYOUT.sidebar.minWidth,
  WORKSPACE_LAYOUT.sidebar.defaultWidth,
  WORKSPACE_LAYOUT.sidebar.maxWidth,
  WORKSPACE_LAYOUT.chrome.height,
]

describe('WORKSPACE_LAYOUT', () => {
  it('keeps the default sidebar width inside its bounds', () => {
    const { minWidth, defaultWidth, maxWidth } = WORKSPACE_LAYOUT.sidebar

    expect(minWidth).toBeLessThan(defaultWidth)

    expect(defaultWidth).toBeLessThan(maxWidth)
  })

  it('uses positive finite dimensions', () => {
    for (const dimension of PIXEL_DIMENSION_TOKENS) {
      expect(Number.isFinite(dimension)).toBe(true)

      expect(dimension).toBeGreaterThan(0)
    }
  })

  it('uses integer pixel dimensions', () => {
    for (const dimension of PIXEL_DIMENSION_TOKENS) {
      expect(Number.isInteger(dimension)).toBe(true)
    }
  })

  it('uses a short layout animation', () => {
    const duration = WORKSPACE_LAYOUT.motion.layoutDurationSeconds

    expect(Number.isFinite(duration)).toBe(true)

    expect(duration).toBeGreaterThan(0)

    /*
     * Layout animation should remain responsive.
     * Longer sequences belong to feature animation,
     * not shell geometry transitions.
     */
    expect(duration).toBeLessThanOrEqual(0.5)
  })

  it('uses a valid cubic-bezier tuple', () => {
    const ease = WORKSPACE_LAYOUT.motion.layoutEase

    expect(ease).toHaveLength(4)

    for (const controlPoint of ease) {
      expect(Number.isFinite(controlPoint)).toBe(true)
    }

    const [firstX, , secondX] = ease

    /*
     * CSS and Motion require the X control points
     * to remain in the 0..1 range.
     */
    expect(firstX).toBeGreaterThanOrEqual(0)

    expect(firstX).toBeLessThanOrEqual(1)

    expect(secondX).toBeGreaterThanOrEqual(0)

    expect(secondX).toBeLessThanOrEqual(1)
  })
})
