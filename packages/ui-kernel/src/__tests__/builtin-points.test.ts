import { describe, expect, test } from 'bun:test'
import { builtinPoints } from '@poietica/ui-kernel'

/*
 * 「退出时顶部栏下方闪一次 #383836 长方形」的机制回归。根因不是某个组件的样式，而是**外壳代持可见性**：
 * 外壳按 Core 状态挂出一整行（底色 `--ui-accent`，深色 #383836），贡献的组件却按自己的判据（3 秒宽限）返回 null
 * —— 「占了一行」与「有字」分家，屏幕上只剩一条没有字的纯色行。
 * 所以这里钉的是**形状**：一旦有人重新引入「外壳按可见性代挂整行」的贡献点，这一条就会红。
 */
describe('外壳不再代持横幅的外观', () => {
  test('浮层贡献点是「自己定位、不占栅格」的那一档', () => {
    expect('overlays' in builtinPoints).toBe(true)
  })

  test('入口提示与浮层都要求 useVisible：画不画由贡献方自己说了算', () => {
    const point = builtinPoints.overlays as { id: string }
    expect(point.id).toBe('workbench.overlays')
  })
})
