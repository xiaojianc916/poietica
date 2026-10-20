import { platformContract } from '@poietica/feature-platform/contract'
import { BannersToken, builtinPoints, type CommandItem, defineUiFeature } from '@poietica/ui-kernel'
import type { Workspace } from '../contract'
import { WorkspacesUiToken } from '../ui-api'
import { createWorkspacesApi } from './api'

export default defineUiFeature({
  id: 'workspaces',
  dependsOn: ['platform'],
  setup(ctx) {
    const api = createWorkspacesApi(ctx)
    const platform = ctx.rpc(platformContract)
    const banners = ctx.services.get(BannersToken)

    /* 当前工作区保存在 store（不持久化）。别的功能通过 WorkspacesUiToken 读它、切它。 */
    let items: readonly Workspace[] = []
    let activeId: string | null = null
    /* 组件要**订阅**着读这两格。getState()／闭包变量是一次性快照：消费方会在 store 还空着时渲染一遍就再也不重画。 */
    const listeners = new Set<() => void>()
    const activeListeners = new Set<(w: Workspace | null) => void>()
    const bump = (): void => {
      for (const l of [...listeners]) l()
      const active = items.find((w) => w.id === activeId) ?? null
      for (const l of [...activeListeners]) l(active)
    }

    /*
     * 名单变了只校正**失效**的当前项目。`selectFirst` 只在启动那一次为真：那时还没有「当前项目」，
     * 按最近打开选一个（原来的行为）；其余重载不替用户补选 —— 删掉当前项目之后 `activeId` 就是 null，
     * 「还没选项目」是一个真实的界面状态，入口页据此禁用发送。
     */
    const reload = async (selectFirst = false): Promise<void> => {
      items = await api.list()
      if (activeId !== null && !items.some((w) => w.id === activeId)) activeId = null
      if (activeId === null && selectFirst && items[0] !== undefined) activeId = items[0].id
      bump()
    }

    const pickAndAdd = async (): Promise<Workspace | null> => {
      const picked = await platform.call('dialog.pickFolder', { title: '选择工作文件夹' })
      if (picked.path === null) return null
      try {
        const workspace = await api.add(picked.path)
        await reload()
        activeId = workspace.id
        bump()
        return workspace
      } catch (e) {
        banners.error(e)
        return null
      }
    }

    ctx.lifecycle.onDispose(api.onChanged(() => void reload()).dispose)

    ctx.lifecycle.onCoreReady(async () => {
      await reload(true)
    })

    /* legacy 的侧栏是「导航行 + 会话列表 + 底部行」三段，工作区只以**会话列表里的组头**出现；`Repositories` 那一行是会话列表面板内部的工具栏，
     * 不是外壳的一条导航。方案把「工作区选择器（order 10）」记成一条 sidebarSections 是表述上的歧义，按产品实际外观（基准截图 #02）取「会话列表里的
     * 组头」（2026-10-08 已补记为偏差 #74）。选择器组件本身仍住在 ui-api，输入框下方那一行由 conversation 取用。
     *
     * 设置页不再有「工作区」一格：legacy 的 SECTIONS 里没有这一页，它是设计阶段加出来的，工作区仍由侧栏的「打开文件夹…」与会话列表里的组头管理。 */
    const command = (id: string, title: string, run: () => void): void => {
      ctx.contribute(builtinPoints.commands, { id, title, category: '工作区', run } satisfies CommandItem)
    }
    command('workspaces.open', '打开文件夹…', () => void pickAndAdd())
    ctx.contribute(builtinPoints.keybindings, { command: 'workspaces.open', key: 'Ctrl+O' })

    // ── ui-api ────────────────────────────────────────────────────────────
    ctx.services.provide(WorkspacesUiToken, {
      store: {
        getState: () => ({ items, activeId }),
        getInitialState: () => ({ items, activeId }),
        setState: () => undefined,
        subscribe: (listener: () => void) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
      } as never,
      active: () => items.find((w) => w.id === activeId) ?? null,
      setActive: (id) => {
        activeId = id
        bump()
        /* 当前工作区本身**不持久化**，重启后默认取 `list()` 的第一项 = `last_opened_at` 最新的那一条。少了这一步，切换只活在内存里，重启后顺序
         * 没变，屏幕就回到旧的那个工作区（真实故障）。`touch` 不发通知，所以这里不会让列表抖动。 */
        if (id !== null) {
          void api.touch(id).catch(() => undefined)
        }
      },
      subscribeActive: (listener) => {
        activeListeners.add(listener)
        return () => {
          activeListeners.delete(listener)
        }
      },
      pickAndAdd,
      remove: async (id) => {
        try {
          await api.remove(id)
          /* 删的是当前项目就回到「还没选」，不替用户挑下一个：入口页会用那条提示挡住发送。 */
          if (activeId === id) activeId = null
          await reload()
        } catch (e) {
          banners.error(e)
        }
      },
    })
  },
})
