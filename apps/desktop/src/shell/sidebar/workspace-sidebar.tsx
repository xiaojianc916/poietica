import './sidebar-rows.css'

import type { SurfaceId } from '@poietica/workspace'
import type { ReactNode } from 'react'
import { SidebarFooter } from './sidebar-footer'
import { SidebarNav } from './sidebar-nav'

export interface WorkspaceSidebarProps {
  readonly updateRow?: ReactNode
  readonly activeNavigationId: SurfaceId | null
  readonly panel: ReactNode
  readonly onSurfaceActivate: (surfaceId: SurfaceId) => void
  readonly onCreateConversation: () => void
  readonly onSettingsOpen: () => void
  readonly onDeveloperToolsOpen: () => void
}

/**
 * 侧边栏。
 *
 * 结构是固定的三段：导航 / 面板 / 底部行。导航项不改这里的内容，只在主区域
 * 打开对应表面——侧边栏在整个会话期间保持同一副样子，用户不会因为点了一个
 * 导航项就丢失会话记录。
 *
 * 面板本体由 apps 组合根注入，features/* 之间不互相依赖这条规则不变。
 */
export function WorkspaceSidebar({
  activeNavigationId,
  panel,
  updateRow,
  onSurfaceActivate,
  onCreateConversation,
  onSettingsOpen,
  onDeveloperToolsOpen,
}: WorkspaceSidebarProps) {
  return (
    <section className="workspace-sidebar flex h-full min-h-0 min-w-0 flex-col bg-sidebar">
      <SidebarNav
        activeNavigationId={activeNavigationId}
        onCreateConversation={onCreateConversation}
        onSurfaceActivate={onSurfaceActivate}
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{panel}</div>

      <SidebarFooter
        onDeveloperToolsOpen={onDeveloperToolsOpen}
        onSettingsOpen={onSettingsOpen}
        updateRow={updateRow}
      />
    </section>
  )
}
