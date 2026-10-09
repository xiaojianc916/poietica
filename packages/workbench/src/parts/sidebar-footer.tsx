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
import { builtinPoints, FeatureScope, useContributions, useKernel } from '@poietica/ui-kernel'
import { BookOpen, CircleQuestionMark, Code, Settings } from 'lucide-react'
import { type ReactNode, Suspense } from 'react'
import { PartSkeleton } from './part-skeleton'

const REPOSITORY_URL = 'https://github.com/xiaojianc916/poietica'

/**
 * 侧栏底部行。**迁移自** legacy `shell/sidebar/sidebar-footer.tsx`：
 * DOM、类名、图标与三条菜单项一字未改；数据来源换成内核服务与命令服务。
 * legacy 的 `updateRow` 插槽换成 `helpMenuItems` 贡献点：条目由功能自己贡献
 * （update 贡献「检查更新」），外壳不认识任何具体功能（守则 2/3）。
 *
 * 「开发者工具」那一项由**菜单自己**执行命令（`HelpMenu` 内），这里不再传回调：
 * 早先两处都执行一次，点一下会开两个 DevTools。
 */
export function SidebarFooter({ settingsActive = false }: { readonly settingsActive?: boolean }): ReactNode {
  const { kernelServices } = useKernel()
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
      <div aria-hidden="true" className="flex-1" />

      <HelpMenu />

      <FooterButton
        active={settingsActive}
        icon={Settings}
        label="设置"
        onClick={() => {
          kernelServices.navigation.navigate({ surface: 'workbench.settings', params: {} })
        }}
      />
    </div>
  )
}

/** 底部行的一枚图标按钮：悬停出现提示，激活态用侧栏强调底色。 */
function FooterButton({
  label,
  icon: Icon,
  onClick,
  active = false,
}: {
  readonly label: string
  readonly icon: React.ComponentType<{ 'aria-hidden'?: 'true'; className?: string }>
  readonly onClick: () => void
  readonly active?: boolean
}): ReactNode {
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

/**
 * 帮助菜单：项目文档 / 功能贡献的行（如「检查更新」）/ GitHub / 开发者工具。
 *
 * 贡献行落在「项目文档」与「GitHub」之间 —— legacy 的 `{updateRow}` 就在这个位置。
 */
function HelpMenu(): ReactNode {
  const { kernelServices } = useKernel()
  const rows = useContributions(builtinPoints.helpMenuItems)
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
          <HelpMenuItem href={`${REPOSITORY_URL}/tree/main/docs`} icon={BookOpen} label="项目文档" />

          {rows.map((c) => (
            <FeatureScope featureId={c.featureId} key={c.item.id}>
              <Suspense fallback={<PartSkeleton />}>
                <c.item.component />
              </Suspense>
            </FeatureScope>
          ))}

          <HelpMenuItem href={REPOSITORY_URL} icon={GithubMark} label="GitHub" />
        </DropdownMenuGroup>

        <DropdownMenuSeparator />

        <DropdownMenuGroup>
          <HelpMenuItem
            icon={Code}
            label="开发者工具"
            onClick={() => {
              void kernelServices.commands.execute('platform.openDevtools')
            }}
          />
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function HelpMenuItem({
  label,
  icon: Icon,
  href,
  onClick,
}: {
  readonly label: string
  readonly icon: React.ComponentType<{ 'aria-hidden'?: 'true'; className?: string }>
  readonly href?: string
  readonly onClick?: () => void
}): ReactNode {
  const content = (
    <>
      <Icon aria-hidden="true" className="text-muted-foreground" />
      <span>{label}</span>
    </>
  )

  /*
   * 内容只有这一份：走链接时放进 <a> 里，走按钮时交给菜单项。
   *
   * 不是重复 —— 链接必须有可访问内容（WCAG 2.4.4，biome 的 useAnchorContent 同一条），
   * 而 render 插槽里那个空 <a> 在静态上根本看不出内容从哪来。
   */
  if (href !== undefined) {
    return (
      <DropdownMenuItem
        onClick={onClick}
        render={
          <a href={href} rel="noreferrer">
            {content}
          </a>
        }
      />
    )
  }

  return <DropdownMenuItem onClick={onClick}>{content}</DropdownMenuItem>
}
