import { BrowserPanelToggle } from '../browser/browser-dock'
import './conversation-header.css'

/*
 * 会话页头：横贯主区整宽的矮容器，右端收页面级动作；只随对话表面在场，
 * 入口态没有它。与转录的衔接不画线，雾是画布里的 conversation-veil。
 */
export function ConversationHeader() {
  return (
    <header className="conversation-header" data-assistant-skin>
      <BrowserPanelToggle />
    </header>
  )
}
