import { describe, expect, it } from 'vitest'
import { WORKSPACE_LAYOUT } from './workspace-layout'
import { workspaceLayoutStore } from './workspace-layout-store'

/*
 * 这个 store 驱动产品里点击频率最高的控件之一，此前完全没有测试覆盖，
 * 一次冷启动误关的回归因此没有被任何检查拦住。以下用例锁死三件事：
 * 导入不产生副作用、开合真的翻转、快照引用符合 useSyncExternalStore 契约。
 */
describe('workspaceLayoutStore', () => {
  it('导入模块不会改变默认布局意图', () => {
    /*
     * 关键回归：无论运行环境的视口是什么，仅仅导入本模块都不允许把侧边栏
     * 打成关闭。视口相关的降级属于渲染层的派生状态。
     */
    expect(workspaceLayoutStore.getSnapshot().sidebarOpen).toBe(true)
  })

  it('切换侧边栏会翻转意图', () => {
    const before = workspaceLayoutStore.getSnapshot().sidebarOpen

    workspaceLayoutStore.toggleSidebar()

    expect(workspaceLayoutStore.getSnapshot().sidebarOpen).toBe(!before)

    workspaceLayoutStore.toggleSidebar()

    expect(workspaceLayoutStore.getSnapshot().sidebarOpen).toBe(before)
  })

  it('状态变化时快照换引用，无变化时保持同一引用', () => {
    const first = workspaceLayoutStore.getSnapshot()

    workspaceLayoutStore.setSidebarOpen(!first.sidebarOpen)

    const second = workspaceLayoutStore.getSnapshot()

    expect(second).not.toBe(first)

    /*
     * 重复提交同一个值必须返回同一个引用，否则 useSyncExternalStore 会在
     * 每次通知后都判定状态已变，触发无穷重渲染。
     */
    workspaceLayoutStore.setSidebarOpen(second.sidebarOpen)

    expect(workspaceLayoutStore.getSnapshot()).toBe(second)

    workspaceLayoutStore.setSidebarOpen(first.sidebarOpen)
  })

  it('宽度被夹在产品约定的区间内', () => {
    workspaceLayoutStore.setSidebarWidth(WORKSPACE_LAYOUT.sidebar.minWidth - 500)

    expect(workspaceLayoutStore.getSnapshot().sidebarWidth).toBe(WORKSPACE_LAYOUT.sidebar.minWidth)

    workspaceLayoutStore.setSidebarWidth(WORKSPACE_LAYOUT.sidebar.maxWidth + 500)

    expect(workspaceLayoutStore.getSnapshot().sidebarWidth).toBe(WORKSPACE_LAYOUT.sidebar.maxWidth)

    workspaceLayoutStore.setSidebarWidth(WORKSPACE_LAYOUT.sidebar.defaultWidth)
  })

  /* drag 不是吸收态：卡在粗线的那类回归就是从这里开始的。 */
  it('分隔条交互态可以从拖拽回到静止', () => {
    workspaceLayoutStore.setSplitterActivity('hover')
    workspaceLayoutStore.setSplitterActivity('drag')

    expect(workspaceLayoutStore.getSnapshot().splitter).toBe('drag')

    workspaceLayoutStore.setSplitterActivity('idle')

    expect(workspaceLayoutStore.getSnapshot().splitter).toBe('idle')
  })
})
