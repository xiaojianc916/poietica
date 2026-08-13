import { useSyncExternalStore } from 'react'
import { BrowserPanelToggle } from '../browser/browser-dock'
import { browserPanelStore } from '../browser/browser-runtime'
import './conversation-header.css'

/*
 * 会话页头：矮容器，右角是浏览器开关的座位。dock 打开时座位交给 dock
 * 标签条的同几何角位，这里让空 —— 开关屏幕坐标因此在两态间一模一样。
 * 只随对话表面在场，入口态没有它。雾是画布里的 conversation-veil。
 */
export function ConversationHeader() {
  const browser = useSyncExternalStore(
    browserPanelStore.subscribe,
    browserPanelStore.getSnapshot,
    browserPanelStore.getSnapshot,
  )

  return (
    <header className="conversation-header" data-assistant-skin>
      {browser.open ? null : <BrowserPanelToggle />}
    </header>
  )
}
