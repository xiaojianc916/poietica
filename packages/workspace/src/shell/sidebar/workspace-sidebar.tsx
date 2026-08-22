import './sidebar-rows.css'

import type { ReactNode } from 'react'
import type { SurfaceId } from '../../surface-registry'
import { SidebarFooter } from './sidebar-footer'
import { SidebarNav } from './sidebar-nav'

export interface WorkspaceSidebarProps {
  readonly footerLeading?: ReactNode
  readonly activeNavigationId: SurfaceId | null
  readonly panel: ReactNode
  readonly onSurfaceActivate: (surfaceId: SurfaceId) => void
  readonly onCreateConversation: () => void
  readonly onCommand: (commandId: string) => void
  readonly onSettingsOpen: () => void
  readonly onDeveloperToolsOpen: () => void
  readonly onCheckUpdates: () => void
}

/**
 * 侧边栏。
 *
 * 结构是固定的三段：导航 / 面板 / 底部行。导航项不改这里的内容，只在主区域
 * 打开对应表面——侧边栏在整个会话期间保持同一副样子，用户不会因为点了一个
 * 导航项就丢失会话记录。
 *
 * 这与它此前的形态相反：原先按 activeNavigationItem 去 panelRenderers 里取面板，
 * 而那张表只有 ai 一个有效键，于是点其余导航项侧边栏就换成占位符。那是活动栏
 * 范式的残留，随图标条一起去掉。
 *
 * 面板本体由 apps 组合根注入，features/* 之间不互相依赖这条规则不变。
 */
export function WorkspaceSidebar({
  activeNavigationId,
  footerLeading,
  panel,
  onSurfaceActivate,
  onCreateConversation,
  onCommand,
  onSettingsOpen,
  onDeveloperToolsOpen,
  onCheckUpdates,
}: WorkspaceSidebarProps) {
  return (
    <section className="workspace-sidebar flex h-full min-h-0 min-w-0 flex-col bg-sidebar">
      <SidebarNav
        activeNavigationId={activeNavigationId}
        onCommand={onCommand}
        onCreateConversation={onCreateConversation}
        onSurfaceActivate={onSurfaceActivate}
      />

      <div className="min-h-0 min-w-0 flex-1 overflow-hidden">{panel}</div>

      <SidebarFooter
        leading={footerLeading}
        onCheckUpdates={onCheckUpdates}
        onDeveloperToolsOpen={onDeveloperToolsOpen}
        onSettingsOpen={onSettingsOpen}
      />
    </section>
  )
}
