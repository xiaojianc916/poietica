import { ConversationPanelControls } from '../shell/auxiliary/auxiliary-dock'
import type { AuxiliaryPanelStore } from '../shell/auxiliary/auxiliary-panel-store'
import { useWorkspaceLayoutState } from '../shell/workspace-layout-store'
import './conversation-header.css'

/*
 * 页头与辅助标签条共享同一组角位控制；面板打开后座位交给标签条，
 * 屏幕坐标不跳。开合只读 workspaceLayoutStore 这一份几何状态。
 */
export function ConversationHeader({
  auxiliaryPanel,
  conversationId,
}: {
  readonly auxiliaryPanel: AuxiliaryPanelStore
  readonly conversationId: string
}) {
  const { auxiliaryThread } = useWorkspaceLayoutState()

  return (
    <header className="conversation-header" data-assistant-skin>
      {auxiliaryThread === conversationId ? null : (
        <ConversationPanelControls conversationId={conversationId} store={auxiliaryPanel} />
      )}
    </header>
  )
}
