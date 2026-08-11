import { Button } from '@poietica/ui'
import {
  useIsSidebarDocked,
  useWorkspaceLayoutMode,
  useWorkspaceLayoutState,
  workspaceLayoutStore,
} from '@poietica/workspace'
import { ChevronLeft, ChevronRight, PanelLeft } from 'lucide-react'
import type { ReactNode } from 'react'
import { WindowControls } from './window-controls'
import './desktop-title-bar.css'

/*
 * 条上按钮只有一种形态：与侧边栏行同高的方形幽灵按钮。三个按钮此前各自抄了一遍
 * 同一串类名，改一次要改三处。
 */
const CHROME_BUTTON_CLASS =
  'size-[var(--ui-control-height-sm)] shrink-0 text-muted-foreground hover:bg-sidebar-accent hover:text-foreground'

/**
 * 活动标签在序列里的前后邻居，以及切换过去的动作。
 *
 * 可用性与动作都由调用方从标签列表派生：标题栏不认识标签模型，只把两个布尔
 * 映射成 disabled、把两个动作接到按钮上。切换走的仍是 store 的 activateTab，
 * 与点击标签、命令面板是同一个入口，不存在第二条改变活动标签的路径。
 *
 * 两端不回绕：标签条是一段有限序列而不是环，走到头就禁用。重排另有拖拽与
 * 键盘两条既有通路，不由这两个键承担。
 */
export interface ActiveTabSequence {
  readonly canActivatePrevious: boolean
  readonly canActivateNext: boolean
  readonly activatePrevious: () => void
  readonly activateNext: () => void
}

export interface DesktopTitleBarProps {
  readonly children: ReactNode
  readonly activeTabSequence: ActiveTabSequence
  readonly onMinimize: () => void
  readonly onMaximize: () => void
  readonly onClose: () => void
  readonly isMaximized: boolean
  readonly windowControlsDisabled?: boolean
}

/**
 * Desktop platform chrome.
 *
 * 窗口拖拽、双击最大化与标题栏右键系统菜单由 WebView2 原生处理：两段拖拽区经
 * CSS -webkit-app-region 在命中测试层面就是标题栏（见 desktop-title-bar.css），
 * 事件在进入网页之前就归系统，前端不监听 mousedown、不经 IPC 中继，光标全程由
 * 系统持有，拖拽起手不再闪光标。
 *
 * 不用 Tauri 的拖拽标注：那条路径是注入脚本捕获 mousedown 后异步调用
 * start_dragging，光标所有权要在 WebView2 与系统模态移动循环之间交接，起手会
 * 闪一次，触屏与笔也拖不动（tauri#13762）。本应用只出 Windows，app-region 的
 * 跨平台限制（tauri#9860 被放弃的原因）在这里不存在。
 *
 * 拖拽区属于标题栏本身。之前全仓库唯一的标注寄生在标签条里，设置界面不渲染
 * 标签条，整窗随之不可拖——归属错了，不是漏标。这里是两段：左侧开合区、中间
 * 填充区；右侧全被窗口控制键占满，没有可标注的空白。
 *
 * 这里不画 chrome 与内容之间的横线。那条线是外壳栅格 chrome 行的边界，由
 * WorkspaceShell 的 header 统一持有；标题栏内部再画一截，就会随内部结构
 * 变化而断续。
 *
 * 这里没有容器级 ARIA 角色。原先整条标注 role="toolbar"，而 toolbar 的契约是
 * roving tabindex，本组件从未实现；它的子元素里还有一整条 role="tablist"，也
 * 不是 toolbar 的合法子元素。声明一个不兑现的角色比不声明更糟。
 */
export function DesktopTitleBar({
  children,
  activeTabSequence,
  onMinimize,
  onMaximize,
  onClose,
  isMaximized,
  windowControlsDisabled = false,
}: DesktopTitleBarProps) {
  /*
   * 侧栏开合是布局意图，store 是它唯一的所有者。此前这两件事由组合根订阅、
   * 再作为 props 钻两层下来 —— 代价是组合根跟着拖拽的每一帧重渲，整棵工作区
   * 的元素随之重建。这里直接读，重渲就只发生在这一条上。
   */
  const { sidebarOpen } = useWorkspaceLayoutState()

  /*
   * 窄窗口里侧栏是收起的（SidebarRegion 由布局模式派生），没有可开合的
   * 东西：留着可点，点一下改的是一份看不见的状态，扩回宽屏时「侧栏怎么
   * 没回来」就是这么来的。
   */
  const layoutMode = useWorkspaceLayoutMode()

  /*
   * 竖线在不在，与侧栏那一长段同一个判据。
   *
   * 此前这里读的是 sidebarOpen —— 那是用户意图，拖窄窗口自动收起时它不变（也
   * 不该变，否则拉宽回来侧栏就回不去了）。于是那一长段的墨色已经透明，chrome
   * 行这一截还亮着：一条线断成了两种状态。
   */
  const isSidebarDocked = useIsSidebarDocked()

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 items-stretch bg-chrome">
      {/*
       * 左上角一个区域，不是两个。
       *
       * 宽度 = max(侧边栏列宽, 开合按钮容器宽)。展开时列宽胜出，右边界与
       * "侧边栏／主界面"分隔线是同一个 x 坐标，竖线因此天然对齐而不是靠手调；
       * 收起时列宽归零、由按钮容器托底，开合按钮永远有落脚点。
       *
       * 按钮留在正常流里。绝对定位同样能固定位置，但列宽归零后它会溢出到右侧
       * 标签条的地盘，被标签条的层叠上下文和不透明底色盖住——按钮还在、只是
       * 点不到，这是上一版的故障。
       *
       * 宽度直接读 motion 正在驱动的 --workspace-sidebar-column-width，收缩过程
       * 跟着面板同一条时间轴、到下限自然刹停，不需要另写一套动画。
       *
       * 下限不是填出来的数：它在 desktop-title-bar.css 里由中线与控件高算出，右侧
       * 留白因此与左侧恒等。此前 workspace-layout.ts 写死 44px，而按同一条中线对称
       * 应得 48px——那段注释在追述一个不成立的推导。
       */}
      <div className="desktop-title-bar__toggle-zone desktop-title-bar__drag-region">
        <Button
          aria-label={sidebarOpen ? '收起侧边栏' : '展开侧边栏'}
          className={CHROME_BUTTON_CLASS}
          disabled={layoutMode === 'narrow'}
          onClick={workspaceLayoutStore.toggleSidebar}
          size="icon"
          type="button"
          variant="ghost"
        >
          <PanelLeft aria-hidden="true" className="size-4" />
        </Button>

        {/*
         * 两个箭头贴着竖线，只在侧边栏展开时在场。
         *
         * 收起之后这一区的宽度只剩开合按钮的落脚点（max() 的兜底项），箭头
         * 留在这里会把开合按钮挤出可视区；何况它们指的是"这一侧的标签"，侧栏
         * 不在场时也没有可指的对象。ml-auto 让它们吸在右边界上，所以位置仍由
         * 上面那个 max() 唯一决定，没有第二份坐标。
         */}
        {sidebarOpen ? (
          <div className="ml-auto flex shrink-0 items-center gap-0.5 pr-2">
            <Button
              aria-label="切换到上一个标签页"
              className={CHROME_BUTTON_CLASS}
              disabled={!activeTabSequence.canActivatePrevious}
              onClick={activeTabSequence.activatePrevious}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ChevronLeft aria-hidden="true" className="size-4" />
            </Button>

            <Button
              aria-label="切换到下一个标签页"
              className={CHROME_BUTTON_CLASS}
              disabled={!activeTabSequence.canActivateNext}
              onClick={activeTabSequence.activateNext}
              size="icon"
              type="button"
              variant="ghost"
            >
              <ChevronRight aria-hidden="true" className="size-4" />
            </Button>
          </div>
        ) : null}

        <span
          aria-hidden="true"
          className="desktop-title-bar__edge"
          data-visible={isSidebarDocked}
        />
      </div>

      <div className="desktop-title-bar__drag-region flex min-w-0 flex-1 items-stretch">
        {children}
      </div>

      <WindowControls
        disabled={windowControlsDisabled}
        isMaximized={isMaximized}
        onClose={onClose}
        onMaximize={onMaximize}
        onMinimize={onMinimize}
      />
    </div>
  )
}
