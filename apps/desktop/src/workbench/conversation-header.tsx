import { BrowserPanelToggle } from '../browser/browser-dock'
import './conversation-header.css'

/*
 * 会话页头：一条矮容器，右端收页面级动作；只随对话表面在场
 * （workspace-container 的同一条判据），入口态没有它。
 * 与转录的衔接不画线，交给 ::after 的雾（见同名 css）。
 */
export function ConversationHeader() {
  return (
    <header className="conversation-header" data-assistant-skin>
      <BrowserPanelToggle />
    </header>
  )
}
