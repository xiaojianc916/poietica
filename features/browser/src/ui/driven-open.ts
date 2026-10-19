import { DEFAULT_PANEL_WIDTH, type LayoutService } from '@poietica/ui-kernel'

/**
 * AI 开始驾驶浏览器时把右坞拉到眼前。面板还停在旧的 420 时，网页只剩一条窄页，驾驶过程根本看不清 ——
 * 当前意图比默认窄就先抬到默认；用户自己拖得更宽则原样保留。
 * 只抬宽度、不收紧：宽窗口下这个值就是意图，窗口放不下时由 LayoutService.geometry 统一让位。
 */
export function revealDrivenBrowser(layout: LayoutService, panelId: string): void {
  const dock = layout.current().right
  const alreadyShowing = dock.open && dock.activeId === panelId

  /* 用户正看着这一格：宽度是他当前的选择，AI 开始驾驶不该把它顶宽。 */
  if (!alreadyShowing && dock.size < DEFAULT_PANEL_WIDTH) {
    layout.setPanelSize('right', DEFAULT_PANEL_WIDTH)
  }

  layout.openPanel('right', panelId)
}
