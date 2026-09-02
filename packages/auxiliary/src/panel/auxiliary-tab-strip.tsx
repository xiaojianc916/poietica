import type { BrowserState } from '@poietica/auxiliary/browser'
import { X } from 'lucide-react'
import type { KeyboardEvent, ReactNode } from 'react'
import { AuxiliaryNewTabMenu, type AuxiliaryPaneOffer, AuxiliaryTabsMenu } from './auxiliary-menu'
import type {
  AuxiliaryFocus,
  AuxiliaryMenuKind,
  AuxiliaryPanelStore,
} from './auxiliary-panel-store'
import { BrowserTabIcon } from './browser-tab-icon'

export interface DockPaneView {
  readonly id: string
  readonly name: string
  readonly icon: ReactNode
}

interface AuxiliaryTabStripProps {
  readonly host: BrowserState | null
  readonly actions: AuxiliaryPanelStore['actions']
  readonly panes: readonly DockPaneView[]
  readonly paneOffers: readonly AuxiliaryPaneOffer[]
  readonly focus: AuxiliaryFocus
  readonly onSelectPane: (id: string) => void
  readonly onClosePane: (id: string) => void
  readonly onOpenPane: AuxiliaryPanelStore['openLauncherPane']
  readonly openMenu: AuxiliaryMenuKind | null
  readonly onMenuChange: (kind: AuxiliaryMenuKind | null) => void
}

interface AuxiliaryTabProps {
  readonly active: boolean
  readonly id: string
  readonly icon: ReactNode
  readonly title: string
  readonly onClose: () => void
  readonly onSelect: () => void
}

export const AUXILIARY_TABPANEL_ID = 'auxiliary-tabpanel'
export const auxiliaryPaneTabId = (id: string) => `auxiliary-pane-${id}`
export const auxiliaryBrowserTabId = (id: number) => `auxiliary-browser-${id}`

function moveTabFocus(event: KeyboardEvent<HTMLDivElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    return
  }

  const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const current = tabs.indexOf(document.activeElement as HTMLButtonElement)
  if (current < 0 || tabs.length === 0) {
    return
  }

  event.preventDefault()
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length
  tabs[next]?.focus()
  tabs[next]?.click()
}

function closeFocusedTab(tab: HTMLButtonElement, onClose: () => void): void {
  const list = tab.closest('[role="tablist"]')
  const tabs = list === null ? [] : [...list.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
  const index = tabs.indexOf(tab)
  const fallback = list?.parentElement?.querySelector<HTMLButtonElement>(
    '[data-auxiliary-tab-fallback] button',
  )
  const next = tabs[index + 1] ?? tabs[index - 1] ?? fallback

  next?.focus()
  if (next?.getAttribute('role') === 'tab') {
    next.click()
  }
  onClose()
}

function AuxiliaryTab({ active, icon, id, onClose, onSelect, title }: AuxiliaryTabProps) {
  return (
    <button
      aria-controls={AUXILIARY_TABPANEL_ID}
      aria-keyshortcuts="Delete"
      aria-selected={active}
      className={
        'group flex max-w-44 shrink-0 items-center gap-1.5 rounded-md py-1 pl-2 pr-2 ' +
        (active ? 'bg-current/[7.8%]' : 'hover:bg-current/5')
      }
      id={id}
      onClick={(event) => {
        if ((event.target as Element).closest('[data-close-tab]') !== null) {
          onClose()
          return
        }
        onSelect()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Delete') {
          event.preventDefault()
          event.stopPropagation()
          closeFocusedTab(event.currentTarget, onClose)
        }
      }}
      onPointerDown={(event) => {
        if ((event.target as Element).closest('[data-close-tab]') !== null) {
          event.preventDefault()
        }
      }}
      role="tab"
      tabIndex={active ? 0 : -1}
      title={title}
      type="button"
    >
      <span aria-hidden className="relative size-3.5 shrink-0">
        <span className="pointer-events-none absolute inset-0 transition-opacity group-hover:opacity-0">
          {icon}
        </span>
        <X
          className="pointer-events-none absolute inset-0 size-3.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100"
          data-close-tab
        />
      </span>
      <span className="min-w-0 truncate text-xs">{title}</span>
    </button>
  )
}

export function AuxiliaryTabStrip({
  host,
  actions,
  focus,
  paneOffers,
  panes,
  onClosePane,
  onMenuChange,
  onOpenPane,
  onSelectPane,
  openMenu,
}: AuxiliaryTabStripProps) {
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 border-b border-current/10 pl-1 pr-10">
      <div
        aria-label="辅助面板标签页"
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        onKeyDown={moveTabFocus}
        role="tablist"
        style={{ scrollbarWidth: 'none' }}
      >
        {panes.map((pane) => (
          <AuxiliaryTab
            active={focus.kind === 'pane' && focus.id === pane.id}
            icon={pane.icon}
            id={auxiliaryPaneTabId(pane.id)}
            key={pane.id}
            onClose={() => {
              onClosePane(pane.id)
            }}
            onSelect={() => {
              onSelectPane(pane.id)
            }}
            title={pane.name}
          />
        ))}
        {(host?.tabs ?? []).map((tab) => (
          <AuxiliaryTab
            active={focus.kind === 'browser' && tab.id === host?.activeTabId}
            icon={<BrowserTabIcon tab={tab} />}
            id={auxiliaryBrowserTabId(tab.id)}
            key={tab.id}
            onClose={() => {
              actions.closeTab(tab.id)
            }}
            onSelect={() => {
              actions.selectTab(tab.id)
            }}
            title={tab.title}
          />
        ))}
      </div>

      <span className="contents" data-auxiliary-tab-fallback>
        <AuxiliaryNewTabMenu
          offers={paneOffers}
          onOpenChange={(next) => {
            onMenuChange(next ? 'new-tab' : null)
          }}
          onOpenPane={onOpenPane}
          open={openMenu === 'new-tab'}
        />
      </span>

      <AuxiliaryTabsMenu
        focus={focus}
        host={host}
        onOpenChange={(next) => {
          onMenuChange(next ? 'tabs' : null)
        }}
        onReopenClosed={actions.reopenClosed}
        onSelectPane={onSelectPane}
        onSelectTab={actions.selectTab}
        open={openMenu === 'tabs'}
        panes={panes}
      />
    </div>
  )
}
