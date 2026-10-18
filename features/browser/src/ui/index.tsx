/// <reference path="../../../../packages/design-system/src/css.d.ts" />

import { attachmentsContract } from '@poietica/feature-attachments/contract'
import { ConversationUiToken, toolCallRenderers } from '@poietica/feature-conversation/ui-api'
import {
  builtinPoints,
  type CommandItem,
  type DialogService,
  DialogsToken,
  defineUiFeature,
  LayoutToken,
  NavigationToken,
  ToastsToken,
  useLayout,
} from '@poietica/ui-kernel'
import { Globe } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { BrowserState, PickedElement } from '../contract'
import { createBrowserApi } from './api'
import { createBrowserDockTabs } from './dock-tabs'
import { overlayPresent, watchOverlays } from './overlay-watch'
import { BrowserPanel } from './panel'
import { cancelPick, createPickDelivery } from './pick-delivery'
import { createBrowserPanelStore } from './store'
import { createBrowserToolCard } from './tool-card'

import './browser-panel.css'

/* UI 装配。落点：panels(right, order 20)「浏览器」；conversation 的 toolCallRenderers（toolName: 'browser'）；
 * commands —— browser.toggle（Ctrl+Shift+B）、browser.newTab、browser.focusAddress（Ctrl+Shift+L）、browser.pickElement。 */

const PANEL_ID = 'browser.panel'

/** 浮层（命令面板、确认框、Dialog…）都经传送门挂在应用根之外，查询只看那里（P-07）。 */
function dialogOpen(): boolean {
  return overlayPresent(document)
}

function overlayOpen(dialogs: DialogService): boolean {
  return dialogs.current().length > 0 || dialogOpen()
}

export default defineUiFeature({
  id: 'browser',
  dependsOn: ['conversation', 'attachments'],
  setup(ctx) {
    const layout = ctx.services.get(LayoutToken)
    const navigation = ctx.services.get(NavigationToken)
    const dialogs = ctx.services.get(DialogsToken)
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

    ctx.lifecycle.onDispose(
      api.onElementPicked((picked: PickedElement) => {
        void delivery.deliver(picked)
      }).dispose,
    )

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

    /* driven 从 false 变 true 就把面板拉到眼前 —— 每次通知都开会把用户自己关掉的面板反复顶出来。 */
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

    ctx.contribute(builtinPoints.panels, {
      id: PANEL_ID,
      location: 'right',
      order: 20,
      title: '浏览器',
      icon: Globe,
      dockTabs: createBrowserDockTabs({ api, report, store }),
      component: () => <BrowserPanelHost api={api} dialogs={dialogs} report={report} store={store} />,
    })

    /** 「在面板中查看」除了开那一格，还要切到卡片上那条地址所在的标签。 */
    ctx.contribute(toolCallRenderers, {
      toolName: 'browser',
      component: createBrowserToolCard({
        api,
        store,
        report,
        openPanel: () => {
          layout.openPanel('right', PANEL_ID)
        },
      }),
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

/** 面板宿主：算清「该不该让原生视图露面」再交给面板。原生子 webview 摆在外壳之上，右栏收起、活动面板不是浏览器、或有覆盖层时都必须自己收起来。 */
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
  /* 几何指纹：列的开合与宽度换一个值，视口据此重新量一次矩形。侧栏那两项必须在内：位置变化不进 ResizeObserver，拖侧栏分裂条只改位置。 */
  const layoutSignal = useMemo(
    () =>
      `${String(sidebar.visible)}:${String(sidebar.width)}:${String(dock.open)}:${String(dock.size)}:${dock.activeId ?? ''}`,
    [dock.activeId, dock.open, dock.size, sidebar.visible, sidebar.width],
  )

  useEffect(() => {
    const update = (): void => {
      setCovered(overlayOpen(dialogs))
    }

    update()
    const stopDialogs = dialogs.subscribe(update)
    const stopOverlays = watchOverlays(document, update)

    return () => {
      stopDialogs()
      stopOverlays()
    }
  }, [dialogs])

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
