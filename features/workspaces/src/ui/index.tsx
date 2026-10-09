/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { platformContract } from '@poietica/feature-platform/contract'
import { builtinPoints, type CommandItem, defineUiFeature, ToastsToken } from '@poietica/ui-kernel'
import type { Workspace } from '../contract'
import { WorkspacesUiToken } from '../ui-api'
import { createWorkspacesApi } from './api'

export default defineUiFeature({
  id: 'workspaces',
  dependsOn: ['platform', 'preferences'],
  setup(ctx) {
    const api = createWorkspacesApi(ctx)
    const platform = ctx.rpc(platformContract)
    const toasts = ctx.services.get(ToastsToken)

    /*
     * 当前工作区保存在 store（不持久化，07 页 §3C 坑 6）。别的功能（conversation、review）
     * 通过 WorkspacesUiToken 读它、切它。
     */
    let items: readonly Workspace[] = []
    let activeId: string | null = null
    /*
     * 组件要**订阅**着读这两格。写 getState()／闭包变量是一次性快照：消费方会在 store 还空着
     * 时渲染一遍就再也不重画，所以每次变更都通知 listeners 重读。
     */
    const listeners = new Set<() => void>()
    const activeListeners = new Set<(w: Workspace | null) => void>()
    const bump = (): void => {
      for (const l of [...listeners]) l()
      const active = items.find((w) => w.id === activeId) ?? null
      for (const l of [...activeListeners]) l(active)
    }

    const reload = async (): Promise<void> => {
      items = await api.list()
      // 启动后默认取 list() 的第一项（最近使用的）
      if (activeId === null && items[0] !== undefined) activeId = items[0].id
      if (activeId !== null && !items.some((w) => w.id === activeId)) activeId = items[0]?.id ?? null
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
        toasts.error(e)
        return null
      }
    }

    const createScratch = async (): Promise<void> => {
      try {
        const workspace = await api.createScratch()
        await reload()
        activeId = workspace.id
        bump()
      } catch (e) {
        toasts.error(e)
      }
    }

    ctx.lifecycle.onDispose(api.onChanged(() => void reload()).dispose)

    ctx.lifecycle.onCoreReady(async () => {
      await reload()
    })

    /*
     * 侧栏不出工作区选择器。
     *
     * legacy 的侧栏是「导航行 + 会话列表 + 底部行」三段，工作区只以**会话列表里的组头**
     * 出现（`packages/conversation` 的 AssistantThreadList）；`Repositories` 那一行是
     * 会话列表面板内部的工具栏，不是外壳的一条导航。07 页 §3E 把「工作区选择器（order 10）」
     * 记成一条 sidebarSections，与 03 页 §4「workbench 只渲染贡献点」并列读下来会让人
     * 以为它是一条独立的侧栏段 —— 那是方案表述上的一个歧义，按产品实际外观（用户给定的
     * 基准截图 #02）取「会话列表里的组头」—— 这条按守则 11 不自行发明结构，原样保留
     * （原注释称「已记入 refactor-log」但检索不到，2026-10-08 已补记为偏差 #74）。
     *
     * 选择器组件本身仍然住在 ui-api（03 页 §4.4），输入框下方那一行由 conversation 取用。
     */

    /*
     * 设置页不再有「工作区」一格（产品负责人 2026-10-06）：legacy 的 SECTIONS 里没有这一页，
     * 它是 07 页 §3E 在设计阶段加出来的。工作区仍然由侧栏的「打开文件夹…」与会话列表里的
     * 组头管理，这一页的贡献撤掉之后组件本身（settings-page.tsx）也不再被引用。
     */

    // ── 命令 ──────────────────────────────────────────────────────────────
    const command = (id: string, title: string, run: () => void): void => {
      ctx.contribute(builtinPoints.commands, { id, title, category: '工作区', run } satisfies CommandItem)
    }
    command('workspaces.open', '打开文件夹…', () => void pickAndAdd())
    command('workspaces.newScratch', '新建临时对话', () => void createScratch())
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
        /*
         * 切到哪个工作区就把它记成「最近使用」：当前工作区本身**不持久化**（07 页 §3C），
         * 重启后默认取 `list()` 的第一项 = `last_opened_at` 最新的那一条。少了这一步，
         * 切换只活在内存里，重启后顺序没变，屏幕就回到旧的那个工作区（真实故障）。
         * `touch` 不发通知，所以这里不会让列表抖动。
         */
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
      createScratch,
    })
  },
})
