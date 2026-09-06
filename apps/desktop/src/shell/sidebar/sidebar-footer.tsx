import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  GithubMark,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@poietica/design-system'
import { BookOpen, CircleQuestionMark, Code, Settings } from 'lucide-react'

import type { ReactNode } from 'react'

import type { SurfaceIcon } from '../surfaces/surface-icons'

const REPOSITORY_URL = 'https://github.com/xiaojianc916/poietica'

export interface SidebarFooterProps {
  readonly updateRow?: ReactNode
  readonly onSettingsOpen: () => void
  readonly onDeveloperToolsOpen: () => void

  readonly settingsActive?: boolean
}

export function SidebarFooter({
  updateRow,
  onSettingsOpen,
  onDeveloperToolsOpen,
  settingsActive = false,
}: SidebarFooterProps) {
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
      <div aria-hidden="true" className="flex-1" />

      <HelpMenu onDeveloperToolsOpen={onDeveloperToolsOpen} updateRow={updateRow} />

      <FooterButton active={settingsActive} icon={Settings} label="设置" onClick={onSettingsOpen} />
    </div>
  )
}

interface FooterButtonProps {
  readonly label: string
  readonly icon: SurfaceIcon
  readonly onClick: () => void
  readonly active?: boolean
}

function FooterButton({ label, icon: Icon, onClick, active = false }: FooterButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={`size-7 hover:bg-sidebar-accent hover:text-foreground ${
              active ? 'bg-sidebar-accent text-foreground' : 'text-muted-foreground'
            }`}
            onClick={onClick}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Icon aria-hidden="true" />
          </Button>
        }
      />

      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  )
}

function HelpMenu({
  onDeveloperToolsOpen,
  updateRow,
}: {
  readonly onDeveloperToolsOpen: () => void
  readonly updateRow: ReactNode
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="帮助"
        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground data-[popup-open]:bg-sidebar-accent data-[popup-open]:text-foreground"
      >
        <CircleQuestionMark aria-hidden="true" className="size-4" />
      </DropdownMenuTrigger>

      <DropdownMenuContent align="end" className="min-w-40" side="top">
        <DropdownMenuGroup>
          <HelpMenuItem
            href={`${REPOSITORY_URL}/tree/main/docs`}
            icon={BookOpen}
            label="项目文档"
          />

          {updateRow}

          <HelpMenuItem href={REPOSITORY_URL} icon={GithubMark} label="GitHub" />
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <HelpMenuItem icon={Code} label="开发者工具" onClick={onDeveloperToolsOpen} />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

interface HelpMenuItemProps {
  readonly label: string
  readonly icon: SurfaceIcon

  readonly href?: string
  readonly onClick?: () => void
}

function HelpMenuItem({ label, icon: Icon, href, onClick }: HelpMenuItemProps) {
  const asLink = href === undefined ? {} : { render: <a href={href} rel="noreferrer" /> }

  return (
    <DropdownMenuItem onClick={onClick} {...asLink}>
      <Icon aria-hidden="true" className="text-muted-foreground" />

      <span>{label}</span>
    </DropdownMenuItem>
  )
}
