import { type NavigationService, NavigationToken, useNavigation, useService } from '@poietica/ui-kernel'
import { SquarePen } from 'lucide-react'
import type { ReactNode } from 'react'

/*
 * 行的几何在 workbench 的全局样式（.sidebar-nav-row / __icon / __label），别在这里改。
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
