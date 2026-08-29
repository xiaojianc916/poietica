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
} from '@poietica/ui'
import { BookOpen, CircleQuestionMark, Code, Settings } from 'lucide-react'

import type { ReactNode } from 'react'

import type { SurfaceIcon } from '../surface-icons'

/*
 * 仓库地址。
 *
 * 与 apps/desktop/src-tauri/tauri.conf.json 的 bundle.homepage 是同一个串。这
 * 是分层的代价而不是疏忽：这个包在第 4 层，读不到 apps 里的构建配置，而把它
 * 做成 prop 从组合根传下来，等于为一个常量铺一条跨三层的通道。两处任一改动，
 * 另一处要跟着改。
 */
const REPOSITORY_URL = 'https://github.com/xiaojianc916/poietica'

export interface SidebarFooterProps {
  /**
   * 帮助菜单里「检查更新」那一行。
   *
   * 是插槽而不是一个回调：这一层不认识"更新"这件事，而那一行要自己回话，点击与回话
   * 因此归同一个节点。具体节点由 apps 组合根注入 —— 外壳只摆放已经接好线的 Part。
   */
  readonly updateRow?: ReactNode
  readonly onSettingsOpen: () => void
  readonly onDeveloperToolsOpen: () => void
  /**
   * 当前是否停留在设置界面。
   *
   * 设置界面会盖住侧边栏，所以唯一看得见的齿轮是设置导航底部复用的这一个，
   * 它在设置里保持背景亮起 —— 和导航项的选中态同一套视觉。
   */
  readonly settingsActive?: boolean
}

/**
 * 侧边栏底部行。
 *
 * Poietica 是本地优先产品，没有登录账号，因此左侧刻意留空 —— 不放占位头像、
 * 不放假的套餐名。右下角是全局入口（帮助 + 设置），它们原先挂在图标 rail 的
 * 底部，rail 移除后由这里承接，入口数量不变。
 */
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

      {/* 下限而不是定值：内容短了撑住场面，长了让路。 */}
      <DropdownMenuContent align="end" className="min-w-40" side="top">
        <DropdownMenuGroup>
          <HelpMenuItem
            href={`${REPOSITORY_URL}/tree/main/docs`}
            icon={BookOpen}
            label="项目文档"
          />

          {updateRow}

          {/*
           * 品牌标记，不是形近的 UI 字形。此前这里是 Message（对话气泡）—— 那不
           * 是 GitHub 的图标，只是一个语义相近的字形在凑数。
           */}
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
  /**
   * 外链行给一个真的 href。
   *
   * 不是 onClick 回调，也不需要从组合根往下传任何东西：apps/desktop 已经在
   * document 上装了一条 capture 阶段的监听（presentation/chrome/external-links
   * .ts），凡是 a[href] 且协议是 http(s)/mailto 就拦下来交给系统浏览器。此前
   * 这一行点了没反应，原因是 Base UI 的 Menu.Item 渲染出来是个 div —— 那条监
   * 听的 a[href] 判断压根匹配不到它。
   *
   * 于是这一层只需要说清「它是一条链接」这个事实，跨进程那一半归 apps。两边
   * 谁也不必知道对方存在，这个包（第 4 层）也就不必认识 Tauri。
   */
  readonly href?: string
  readonly onClick?: () => void
}

function HelpMenuItem({ label, icon: Icon, href, onClick }: HelpMenuItemProps) {
  /*
   * 这条抑制说的是一个事实，不是一个借口。
   *
   * 渲染出来的 DOM 完全合规：一个带 href、里面有图标与文字的 <a>。图标与文字
   * 是下面那两行，由 DropdownMenuItem 注入到这个锚点里面 —— 而那发生在组件
   * 边界的另一侧，静态分析看不到，于是它只能看见一个空锚点。
   *
   * 这是这条规则的已知盲区，不是这段代码的毛病：biomejs/biome#10663 是同一条
   * 规则在 Vue <slot/> 上的同一种误报，结论逐字是「Biome cannot know whether
   * the actual content is accessible or not, so it should not trigger」。
   *
   * 试过而不成立的两条路，记在这里免得下次再试一遍：
   *
   * 一、Biome 文档里那条「内容经 render 属性给出」的豁免只覆盖「直接作为属性值」
   *     的节点。包进一个三元表达式，锚点就深了一层，规则跟丢。
   *
   * 二、补一个 aria-label={label} 能不能过，文档没有直说；而它会用一个重复的
   *     串盖掉真正由 children 算出来的可访问名。为了过 lint 去改可访问性语义，
   *     方向是反的。（规则豁免登记在 biome.json overrides。）
   */
  const asLink = href === undefined ? {} : { render: <a href={href} rel="noreferrer" /> }

  return (
    <DropdownMenuItem onClick={onClick} {...asLink}>
      <Icon aria-hidden="true" className="text-muted-foreground" />

      {/*
       * 一行只有图标与标签。
       *
       * 此前每个外链行尾还挂一个 ExternalLink 箭头。连着三行都有同一个记号，等
       * 于没有记号 —— macOS 的帮助菜单、Windows 设置里的链接项都不逐行打它。箭头
       * 走了之后 external 只剩一个取值，prop 与分支一起走。
       *
       * 标签上的 flex-1 也去掉了：它当初只是为了把箭头顶到右边。
       */}
      <span>{label}</span>
    </DropdownMenuItem>
  )
}
