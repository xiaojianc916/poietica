import { describe, expect, test } from 'bun:test'
import { DEFAULT_PANEL_WIDTH, type LayoutService } from '@poietica/ui-kernel'
import { revealDrivenBrowser } from '../driven-open'

/* AI 驾驶内置浏览器时会自动把右坞拉到眼前。存盘里那块面板还停在旧的默认宽度时，网页只剩一条窄页 ——
 * 这条用例钉住「拉宽 + 打开」两件事，以及「用户自己拖得更宽时不倒缩」。 */

function fakeLayout(
  size: number,
  over: { readonly open?: boolean; readonly panelId?: string } = {},
): LayoutService & {
  readonly opened: string[]
  readonly sizes: number[]
} {
  const open = over.open ?? false
  const panelId = over.panelId ?? 'conversation.auxiliary'
  const opened: string[] = []
  const sizes: number[] = []
  let current = {
    sidebar: { visible: true, width: 280 },
    right: { open, activeId: open ? panelId : (null as string | null), size },
    auxiliary: { owner: 't1', activeOwner: 't1', fullscreen: false },
  }
  const layout = {
    opened,
    sizes,
    current: () => current,
    setPanelSize: (_location: 'right', px: number) => {
      sizes.push(px)
      current = { ...current, right: { ...current.right, size: px } }
    },
    openPanel: (_location: 'right', panelId: string) => {
      opened.push(panelId)
      current = { ...current, right: { ...current.right, open: true, activeId: panelId } }
    },
  }

  return layout as unknown as LayoutService & { readonly opened: string[]; readonly sizes: number[] }
}

describe('AI 驾驶浏览器时把右坞拉宽', () => {
  test('旧的 420 意图抬到默认宽度，再打开浏览器那一格', () => {
    const layout = fakeLayout(420)

    revealDrivenBrowser(layout, 'browser.panel')

    expect(layout.sizes).toEqual([DEFAULT_PANEL_WIDTH])
    expect(layout.opened).toEqual(['browser.panel'])
  })

  test('已经比默认宽：尊重用户拖出来的宽度，只打开不改宽度', () => {
    const layout = fakeLayout(700)

    revealDrivenBrowser(layout, 'browser.panel')

    expect(layout.sizes).toEqual([])
    expect(layout.opened).toEqual(['browser.panel'])
  })

  test('用户正开着浏览器面板：不动他拖出来的宽度，只把这一格选中', () => {
    const layout = fakeLayout(420, { open: true, panelId: 'browser.panel' })

    revealDrivenBrowser(layout, 'browser.panel')

    expect(layout.sizes).toEqual([])
    expect(layout.opened).toEqual(['browser.panel'])
  })
})
