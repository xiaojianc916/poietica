import { cn } from '@poietica/design-system'
import { describeSurface, SURFACE_NAVIGATION_ORDER, type SurfaceId } from '@poietica/workspace'
import { type SurfaceIcon, surfaceIcon } from '../surfaces/surface-icons'

export interface SidebarNavProps {
  /** 当前高亮的导航项，等于当前活动表面；非表面形态为 null。 */
  readonly activeNavigationId: SurfaceId | null
  readonly onSurfaceActivate: (surfaceId: SurfaceId) => void
  readonly onCreateConversation: () => void
  /** 动作行按下去执行的那条命令。执行由组合根接线，这一层只报 id。 */
  readonly onCommand: (commandId: string) => void
}

export function SidebarNav({
  activeNavigationId,
  onSurfaceActivate,
  onCreateConversation,
  onCommand,
}: SidebarNavProps) {
  return (
    <nav aria-label="主导航" className="workspace-sidebar__nav shrink-0 pb-1 pt-2">
      <ul className="flex flex-col gap-px">
        <li>
          <NavRow
            active={activeNavigationId === 'ai'}
            icon={surfaceIcon('ai')}
            label={describeSurface('ai').title}
            onClick={onCreateConversation}
          />
        </li>

        {SURFACE_NAVIGATION_ORDER.map((surfaceId) => {
          const { title, activation } = describeSurface(surfaceId)

          return (
            <li key={surfaceId}>
              <NavRow
                active={activation.kind !== 'command' && surfaceId === activeNavigationId}
                icon={surfaceIcon(surfaceId)}
                label={title}
                onClick={() => {
                  if (activation.kind === 'command') {
                    onCommand(activation.commandId)
                    return
                  }

                  onSurfaceActivate(surfaceId)
                }}
              />
            </li>
          )
        })}
      </ul>
    </nav>
  )
}

interface NavRowProps {
  readonly label: string
  readonly icon: SurfaceIcon
  readonly active?: boolean
  readonly onClick: () => void
}

function NavRow({ label, icon: Icon, active = false, onClick }: NavRowProps) {
  return (
    <button
      aria-current={active ? 'page' : undefined}
      className={cn(
        'sidebar-nav-row text-xs text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground',
        active && 'bg-sidebar-accent text-foreground',
      )}
      onClick={onClick}
      type="button"
    >
      <Icon aria-hidden="true" className="sidebar-nav-row__icon" />

      <span className="truncate font-medium">{label}</span>
    </button>
  )
}
