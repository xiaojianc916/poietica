import { workspaceLayoutStore } from '@poietica/workspace'
import { useSyncExternalStore } from 'react'

import { BrowserPanelToggle } from '../browser/browser-dock'
import './conversation-header.css'

/*
 * 会话页头：矮容器，右角是浏览器开关的座位。dock 打开时座位交给 dock
 * 标签条的同几何角位，这里让空 —— 开关屏幕坐标因此在两态间一模一样。
 * 只随对话表面在场，入口态没有它。雾是画布里的 conversation-veil。
 *
 * 开合判据读 workspaceLayoutStore —— 可见性的唯一所有者。此前误读
 * browserPanelStore 快照里不存在的 open 字段，条件恒假，dock 打开后
 * 这里仍画着一个开关，与角位那颗并存成两颗。
 */
export function ConversationHeader() {
  const { browserOpen } = useSyncExternalStore(
    workspaceLayoutStore.subscribe,
    workspaceLayoutStore.getSnapshot,
    workspaceLayoutStore.getSnapshot,
  )

  return (
    <header className="conversation-header" data-assistant-skin>
      {browserOpen ? null : <BrowserPanelToggle />}
    </header>
  )
}
