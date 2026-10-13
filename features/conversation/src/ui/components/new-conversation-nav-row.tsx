import { type NavigationService, NavigationToken, useNavigation, useService } from '@poietica/ui-kernel'
import { SquarePen } from 'lucide-react'
import type { ReactNode } from 'react'

/*
 * 侧栏顶行「新建对话」。**迁移自** legacy `shell/sidebar/sidebar-nav.tsx` 的第一枚
 * NavRow（icon SquarePen、label 「新建对话」）：行的几何由 workbench 的全局样式持有
 * （.sidebar-nav-row / __icon / __label，逐字迁移自 legacy 的 sidebar-rows.css），
 * 这里只贡献图标、文字与动作。高亮跟着路由：停在入口页（conversation.home）时这一行
 * 亮起（legacy 的判据是活动表面是 'ai'）。
 */
export function NewConversationNavRow(): ReactNode {
  const { route } = useNavigation()
  const navigation = useService(NavigationToken) as NavigationService
  const active = route.surface === 'conversation.home'
  const className = [
    'sidebar-nav-row text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent',
    active ? 'bg-sidebar-accent text-foreground' : '',
  ]
    .filter((part) => part !== '')
    .join(' ')

  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={className}
      onClick={() => {
        navigation.navigate({ surface: 'conversation.home', params: {} })
      }}
      type="button"
    >
      <SquarePen aria-hidden="true" className="sidebar-nav-row__icon" />
      <span className="sidebar-nav-row__label">新建对话</span>
    </button>
  )
}
