import { FileTypeMark } from '@poietica/design-system'
import { fileReferenceOpeners } from '@poietica/feature-conversation/ui-api'
import { WorkspacesUiToken } from '@poietica/feature-workspaces/ui-api'
import {
  BannersToken,
  builtinPoints,
  defineUiFeature,
  type LayoutService,
  LayoutToken,
  type PanelItem,
} from '@poietica/ui-kernel'
import { FileText, FolderTree } from 'lucide-react'
import { createFilesApi } from './api'
import { createFileOpener, TREE_PANEL_ID, VIEWER_PANEL_ID } from './opener'
import { FileTabsStore } from './tabs'
import { FileTreeModels } from './tree-models'
import { FilesTreePanel } from './tree-pane'
import { FileViewerPanel } from './viewer'

/* Core 一次最多监听这么多个工作区（契约 files.watch 的上限）。 */
const WATCH_LIMIT = 32

type DockTabs = NonNullable<PanelItem['dockTabs']>

function basenameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/*
 * 右坞「文件」的装配。两格：
 * - files.tree（order 8，进启动器）：当前工作区的整棵目录树，懒加载、尊重 .gitignore 的筛选；
 * - files.viewer（offer false，标签组）：开着的文件，一个文件一个标签（图标是 Material 文件图标、名是文件名、悬停是相对路径），
 *   按对话分账 —— 与子代理那一组同一规则。
 * 正文里的文件链接经 conversation 的 fileReferenceOpeners 交到这里：先由 Core 解析并校验在工作区之内，再开标签或在树里定位目录。
 * 监听：此刻要看的工作区（当前工作区 ∪ 有标签开着的工作区）作为全集声明给 Core（files.watch），Core 重启后重发。
 */
export default defineUiFeature({
  id: 'files',
  dependsOn: ['conversation', 'workspaces'],
  setup(ctx) {
    const layout = ctx.services.get(LayoutToken)
    const banners = ctx.services.get(BannersToken)
    const workspaces = ctx.services.get(WorkspacesUiToken)
    const api = createFilesApi(ctx)

    const report = (what: string, cause: unknown): void => {
      ctx.logger.warn(`文件 ${what} 失败`, { error: String(cause) })
    }

    const tabs = new FileTabsStore()
    const models = new FileTreeModels(api, report)
    const opener = createFileOpener({
      api,
      tabs,
      layout,
      workspaces,
      banners,
      revealInTree: (owner, workspaceId, path) => {
        models.obtain(workspaceId).reveal(path, true)
        layout.openPane(owner, TREE_PANEL_ID)
      },
    })

    ctx.contribute(builtinPoints.panels, {
      id: TREE_PANEL_ID,
      location: 'right',
      order: 8,
      title: '文件',
      icon: FolderTree,
      component: () => <FilesTreePanel models={models} opener={opener} tabs={tabs} workspaces={workspaces} />,
    })

    ctx.contribute(builtinPoints.panels, {
      id: VIEWER_PANEL_ID,
      location: 'right',
      order: 9,
      title: '文件预览',
      icon: FileText,
      offer: false,
      dockTabs: createFileDockTabs(layout, tabs),
      component: () => <FileViewerPanel api={api} opener={opener} tabs={tabs} />,
    })

    ctx.contribute(fileReferenceOpeners, {
      id: 'files.viewer',
      order: 10,
      open: (request) => {
        opener.openReference({
          path: request.path,
          line: request.line,
          column: request.column,
          owner: request.threadId,
          workspaceId: request.workspaceId,
        })
      },
    })

    ctx.contribute(builtinPoints.commands, {
      id: 'files.openPanel',
      title: '打开文件面板',
      category: '文件',
      run: () => {
        layout.openPanel('right', TREE_PANEL_ID)
      },
    })
    ctx.contribute(builtinPoints.keybindings, { command: 'files.openPanel', key: 'Ctrl+Shift+E' })

    /* ── 账的修剪：布局不再记得的归属、名单里不再有的工作区，这里也不留 ─────────────────────────── */
    ctx.lifecycle.onDispose(
      layout.panes.subscribe(() => {
        tabs.retain(new Set(Object.keys(layout.panes.current().byOwner)))
      }),
    )

    let items = workspaces.store.getState().items
    const pruneWorkspaces = (): void => {
      const next = workspaces.store.getState().items
      if (next === items) return
      items = next
      const known = new Set(next.map((workspace) => workspace.id))
      models.retain(known)
      for (const workspaceId of tabs.workspaceIds()) {
        if (!known.has(workspaceId)) tabs.forgetWorkspace(workspaceId)
      }
    }

    /* ── 监听集合：声明式，变了才重发；Core 重启后（新进程里什么都没有）无条件重发一次 ─────────────── */
    let ready = false
    let declared: string | null = null
    const syncWatch = (force: boolean): void => {
      const { activeId } = workspaces.store.getState()
      const known = new Set(items.map((workspace) => workspace.id))
      const wanted = new Set(tabs.workspaceIds())
      if (activeId !== null) wanted.add(activeId)
      const ids = [...wanted]
        .filter((id) => known.has(id))
        .sort()
        .slice(0, WATCH_LIMIT)
      const key = ids.join('\n')
      if (!ready || (!force && key === declared)) return
      declared = key
      api.watch(ids).catch((cause: unknown) => {
        /* 没声明成功：下一次变化再试，而不是以为已经在听了。 */
        if (declared === key) declared = null
        report('watch', cause)
      })
    }

    ctx.lifecycle.onDispose(
      workspaces.store.subscribe(() => {
        pruneWorkspaces()
        syncWatch(false)
      }),
    )
    ctx.lifecycle.onDispose(
      tabs.subscribe(() => {
        syncWatch(false)
      }),
    )
    ctx.lifecycle.onDispose(
      api.onChanged((workspaceId, paths) => {
        models.changed(workspaceId, paths)
      }).dispose,
    )
    ctx.lifecycle.onCoreLost(() => {
      ready = false
      declared = null
    })
    ctx.lifecycle.onCoreReady(() => {
      ready = true
      pruneWorkspaces()
      syncWatch(true)
      /* 断线期间的变化没有通知：读过的目录全部重读一遍（展开状态留着）。 */
      models.reloadAll()
    })
  },
})

/**
 * 交给右坞的页签面：只报**当前坞归属**那条对话开着的文件。订阅里只在归属换人时额外通知
 * （布局每次拖宽都会变，那些变化与标签无关）。
 */
function createFileDockTabs(layout: LayoutService, tabs: FileTabsStore): DockTabs {
  const owner = (): string | null => layout.current().auxiliary.owner

  return {
    subscribe: (listener) => {
      let held = owner()
      const offTabs = tabs.subscribe(listener)
      const offLayout = layout.subscribe(() => {
        const next = owner()
        if (next !== held) {
          held = next
          listener()
        }
      })
      return () => {
        offTabs()
        offLayout()
      }
    },
    tabs: () => {
      const set = tabs.of(owner())
      if (set === null) return []
      return set.ids.flatMap((id) => {
        const tab = tabs.tab(id)
        if (tab === undefined) return []
        return [
          {
            id,
            title: basenameOf(tab.path),
            hint: tab.path,
            icon: <FileTypeMark className="size-3.5 shrink-0" name={tab.path} />,
            active: id === set.activeId,
          },
        ]
      })
    },
    onSelect: (id) => {
      const held = owner()
      if (held !== null) tabs.select(held, id)
    },
    onClose: (id) => {
      const held = owner()
      if (held === null) return
      const left = tabs.close(held, id)
      /* 最后一个文件关掉、而坞此刻正停在这一组上：选中挪回剩下的最后一格（多半是文件树），不留一块空白面。 */
      if (left === 0 && layout.current().right.activeId === VIEWER_PANEL_ID) {
        const rest = layout.panes.current().byOwner[held]?.ids.filter((paneId) => paneId !== VIEWER_PANEL_ID) ?? []
        const next = rest.at(-1)
        if (next !== undefined) layout.focusPane(held, next)
      }
    },
    /* offer false：启动器里没有这一格，「新开」无从谈起。 */
    onOpen: () => undefined,
  }
}
