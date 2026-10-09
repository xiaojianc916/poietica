/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { attachmentsContract } from '@poietica/feature-attachments/contract'
import { ConversationUiToken, toolCallRenderers } from '@poietica/feature-conversation/ui-api'
import {
  builtinPoints,
  type CommandItem,
  type DialogService,
  DialogsToken,
  defineUiFeature,
  type LayoutService,
  LayoutToken,
  type NavigationService,
  NavigationToken,
  ToastsToken,
  useLayout,
} from '@poietica/ui-kernel'
import { Globe } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { BrowserState, PickedElement } from '../contract'
import { createBrowserApi } from './api'
import { createBrowserDockTabs } from './dock-tabs'
import { BrowserPanel } from './panel'
import { cancelPick, createPickDelivery } from './pick-delivery'
import { createBrowserPanelStore } from './store'
import { BrowserToolCard } from './tool-card'

import './browser-panel.css'

/*
 * 浏览器功能的 UI 装配（07 页 §12E）。
 *
 * 落点与读法：
 *   panels（right, order 20）“浏览器” —— 标签条 / 地址栏 / 工具栏 / 占位 div + setBounds
 *   conversation 的 toolCallRenderers（toolName: 'browser'）—— agent 那条线的工具卡片
 *   commands —— browser.toggle（Ctrl+Shift+B）、browser.newTab、browser.focusAddress
 *               （Ctrl+Shift+L，面板可见时）、browser.pickElement
 *
 * 这一层是唯一认识浏览器之外功能的地方（拾取结果要去 attachments 与 conversation），
 * 面板组件本身只认标签面（store）与 api。
 */

const PANEL_ID = 'browser.panel'

/**
 * 浮在页面上的对话框（命令面板、确认框、设计系统的 Dialog…）。
 *
 * 命令面板的开合不经过内核 —— `packages/workbench/src/palette-state.ts` 是 workbench 的
 * 内部模块，功能不许 import。它渲染出来的浮层倒是一条稳定的 DOM 契约：design-system 的
 * Dialog 建在 Base UI 上，打开时 Popup 带 `role="dialog"` 与 Base UI 自己发的 `data-open`。
 * 认这一对属性，命令面板与其他所有走 Dialog 的浮层都在里面；内核的确认框另有
 * DialogsToken 这一条路（见 overlayOpen）。
 */
function dialogOpen(): boolean {
  return document.querySelector('[role="dialog"][data-open]') !== null
}

/** 覆盖层（对话框、命令面板）：原生视图永远盖在 DOM 之上，有它们时浏览器必须收起来。 */
function overlayOpen(dialogs: DialogService): boolean {
  return dialogs.current().length > 0 || dialogOpen()
}

export default defineUiFeature({
  id: 'browser',
  dependsOn: ['conversation', 'attachments'],
  setup(ctx) {
    const layout = ctx.services.get(LayoutToken) as LayoutService
    const navigation = ctx.services.get(NavigationToken) as NavigationService
    const dialogs = ctx.services.get(DialogsToken) as DialogService
    const toasts = ctx.services.get(ToastsToken)
    const conversation = ctx.services.get(ConversationUiToken)
    const api = createBrowserApi(ctx)
    const store = createBrowserPanelStore(api)
    const attachments = ctx.rpc(attachmentsContract)

    const report = (message: string, cause?: unknown): void => {
      if (cause === undefined) {
        ctx.logger.warn(message)
        return
      }

      ctx.logger.warn(message, { error: String(cause) })
      toasts.error(cause, message)
    }

    const delivery = createPickDelivery({
      importData: async (name, mime, base64) => {
        const attachment = await attachments.call('attachments.importData', { name, mime, base64 })

        return {
          id: attachment.id,
          name: attachment.name,
          kind: attachment.kind,
          previewUrl: attachment.previewUrl,
        }
      },
      activeComposer: () => conversation.activeComposer(),
      navigation,
      report,
    })

    /*
     * 拾取结果：交付失败只报一次（legacy 的两条保护在这里同样成立 —— 交付前确认当前
     * 输入框还在、一次拾取只产生一条提示词，见 pick-delivery.ts）。
     */
    ctx.lifecycle.onDispose(
      api.onElementPicked((picked: PickedElement) => {
        void delivery.deliver(picked)
      }).dispose,
    )

    /* 主动拉一次快照：面板与 driven 提示都要在 core ready 后立刻有值。 */
    const refresh = (): void => {
      void store.refresh().catch((cause: unknown) => {
        report('浏览器状态没能读回', cause)
      })
    }
    ctx.lifecycle.onCoreReady(refresh)
    ctx.lifecycle.onDispose(
      api.onStateChanged((state: BrowserState) => {
        store.apply(state)
      }).dispose,
    )
    ctx.lifecycle.onDispose(() => {
      store.dispose()
    })

    /*
     * agent 操控提示（07 页 §12E）：driven 从 false 变 true 就把面板拉到眼前。
     * 只在翻转那一瞬开面板 —— 每次通知都开会把用户自己关掉的面板反复顶出来。
     */
    let driven = false
    const watchDriven = (state: BrowserState): void => {
      if (state.driven && !driven) {
        layout.openPanel('right', PANEL_ID)
      }

      driven = state.driven
    }
    const stopDriven = store.subscribe(() => {
      const state = store.snapshot()

      if (state !== null) {
        watchDriven(state)
      }
    })
    ctx.lifecycle.onDispose(stopDriven)

    /*
     * 浏览器那一格。标签页由 `dockTabs` 交给右坞的标签条 —— legacy 的浏览器标签与其它
     * 通道的标签同处一条（auxiliary-tab-strip.tsx），新架构里那一条归 workbench，
     * 这里只把「这一格有哪些标签」报上去（真相仍在浏览器宿主的 store 里）。
     */
    ctx.contribute(builtinPoints.panels, {
      id: PANEL_ID,
      location: 'right',
      order: 20,
      title: '浏览器',
      icon: Globe,
      dockTabs: createBrowserDockTabs({ api, report, store }),
      component: () => <BrowserPanelHost api={api} dialogs={dialogs} report={report} store={store} />,
    })

    ctx.contribute(toolCallRenderers, {
      toolName: 'browser',
      component: BrowserToolCard,
    })

    const visible = (): boolean => {
      const dock = layout.current().right

      return dock.open && dock.activeId === PANEL_ID
    }

    const open = (): void => {
      layout.openPanel('right', PANEL_ID)
    }
    const newTab = (): void => {
      open()
      void api.newTab(null).catch((cause: unknown) => {
        report('新标签页没能打开', cause)
      })
    }
    const focusAddress = (): void => {
      if (!visible()) {
        return
      }

      window.dispatchEvent(new CustomEvent('poietica:browser-focus-address'))
    }
    const toggle = (): void => {
      layout.togglePanel('right', PANEL_ID)
    }
    const pickElement = (): void => {
      open()
      const state = store.snapshot()
      const tabId = state?.activeTabId ?? null
      const tab = tabId === null ? null : (state?.tabs.find((candidate) => candidate.id === tabId) ?? null)

      if (tabId === null || tab === null || tab.url === null) {
        report('请先打开一个网页，再拾取元素')
        return
      }

      const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'

      void api.pickElement(tabId, theme).catch((cause: unknown) => {
        report('拾取没能开始', cause)
      })
    }

    const command = (item: CommandItem): void => {
      ctx.contribute(builtinPoints.commands, item)
    }
    command({ id: 'browser.toggle', title: '切换浏览器面板', category: '浏览器', run: toggle })
    command({ id: 'browser.newTab', title: '新建浏览器标签页', category: '浏览器', run: newTab })
    command({
      id: 'browser.focusAddress',
      title: '聚焦地址栏',
      category: '浏览器',
      run: focusAddress,
      enabled: visible,
    })
    command({ id: 'browser.pickElement', title: '拾取网页元素', category: '浏览器', run: pickElement })

    ctx.contribute(builtinPoints.keybindings, { command: 'browser.toggle', key: 'Ctrl+Shift+B' })
    ctx.contribute(builtinPoints.keybindings, {
      command: 'browser.focusAddress',
      key: 'Ctrl+Shift+L',
      when: visible,
    })

    ctx.lifecycle.onDispose(() => {
      void cancelPick(api)
    })
  },
})

/**
 * 面板宿主：把「该不该让原生视图露面」这一件事算清楚再交给面板。
 *
 * 原生子 webview 按逻辑坐标摆在外壳之上，看不见的三种情况必须自己收起来 ——
 * 右栏收起、活动面板不是浏览器、或者有覆盖层（对话框、命令面板）。前两者读
 * LayoutService，后者读 DialogsToken 与浮层的 DOM 契约（见 overlayOpen）。
 */
function BrowserPanelHost({
  api,
  dialogs,
  report,
  store,
}: {
  readonly api: ReturnType<typeof createBrowserApi>
  readonly dialogs: DialogService
  readonly report: (message: string, cause?: unknown) => void
  readonly store: ReturnType<typeof createBrowserPanelStore>
}): ReactNode {
  const layoutState = useLayout()
  const [covered, setCovered] = useState(() => overlayOpen(dialogs))
  const dock = layoutState.right
  const sidebar = layoutState.sidebar
  const visible = dock.open && dock.activeId === PANEL_ID && !covered
  /*
   * 几何指纹：列的开合与宽度换一个值，视口据此重新量一次矩形。它只做同一性比较
   * （viewport.ts 从不解读它），字符串本身就是稳定引用 —— 不必再套一层对象。
   *
   * 侧栏那两项必须在内：位置变化不进 ResizeObserver（视口 x 是侧栏让出来的），
   * 拖侧栏分裂条只改位置——legacy 的指纹同样是 `sidebarOpen:sidebarWidth:auxiliaryWidth`。
   */
  const layoutSignal = useMemo(
    () =>
      `${String(sidebar.visible)}:${String(sidebar.width)}:${String(dock.open)}:${String(dock.size)}:${dock.activeId ?? ''}`,
    [dock.activeId, dock.open, dock.size, sidebar.visible, sidebar.width],
  )

  /* 覆盖层与命令面板都不进内核：两者都靠 DOM 契约盯住（见 overlayOpen 的头注）。 */
  useEffect(() => {
    const update = (): void => {
      setCovered(overlayOpen(dialogs))
    }

    update()
    const stopDialogs = dialogs.subscribe(update)
    const observer = new MutationObserver(update)

    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-open'],
    })

    return () => {
      stopDialogs()
      observer.disconnect()
    }
  }, [dialogs])

  /* 看不见就不能开着拾取：页面上那层面板会留在原地等一个永远不来的点击。 */
  useEffect(() => {
    if (!visible) {
      void cancelPick(api)
    }
  }, [api, visible])

  useEffect(() => {
    const onFocusAddress: EventListener = () => {
      document.querySelector<HTMLInputElement>('[data-browser-address]')?.focus()
    }

    window.addEventListener('poietica:browser-focus-address', onFocusAddress)

    return () => {
      window.removeEventListener('poietica:browser-focus-address', onFocusAddress)
    }
  }, [])

  const onPickToggle = (tabId: number, picking: boolean): void => {
    if (!picking) {
      void cancelPick(api)
      return
    }

    const theme = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'

    void api.pickElement(tabId, theme).catch((cause: unknown) => {
      report('拾取没能开始', cause)
    })
  }

  return (
    <BrowserPanel
      api={api}
      layoutSignal={layoutSignal}
      onPickToggle={onPickToggle}
      report={report}
      store={store}
      visible={visible}
    />
  )
}
