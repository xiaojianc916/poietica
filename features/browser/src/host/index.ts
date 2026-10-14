import { AppError, type Logger } from '@poietica/foundation'
import { type CoreStatus, defineHostModule, type WindowRegistry } from '@poietica/host-kernel'
import { session, WebContentsView } from 'electron'
import { browserContract } from '../contract'
import { BROWSER_PARTITION, type BrowserState, PICKER_CALLBACK_HOST, type PickedElement } from '../contract/entities'
import { browserErrors } from '../contract/errors'
import { createPicker, decodePickerCallback, isPickerCallback, type Picker } from './picker'
import { pickerRuntime } from './picker-runtime'
import { createRelayClient, type RelayTabsPort, relayUrlForStatus } from './relay-client'
import { applySessionPolicy } from './session-policy'
import {
  BROWSER_VIEW_PREFERENCES,
  type BrowserTabs,
  createBrowserTabs,
  type WebContentsLike,
  type WebContentsViewLike,
} from './tabs'

const PICKER_CALLBACK_URL = `https://${PICKER_CALLBACK_HOST}/`

export default defineHostModule({
  id: 'browser',
  contract: browserContract,
  setup(ctx) {
    const picker: Picker = createPicker()
    let tabs: BrowserTabs | null = null

    function ensureTabs(): BrowserTabs {
      if (tabs !== null) {
        return tabs
      }

      const win = ctx.windows.main()

      tabs = createBrowserTabs(viewHostOf(win, ctx.logger), {
        logger: ctx.logger,
        onPickerCallback: (tabId, url) => {
          finishPick(tabId, url)
        },
      })

      return tabs
    }

    function stateOf(): BrowserState {
      return ensureTabs().state()
    }

    /* 拾取回调：token 不等于当前租约就丢弃（页面主世界猜不到 UUID）；否则结束租约并把结果送给 UI。 */
    function finishPick(tabId: number, url: string): void {
      const active = picker.activeTabId()

      if (tabId !== active || !isPickerCallback(url)) {
        return
      }

      const outcome = decodePickerCallback(url)

      if (outcome === null || !picker.finish(tabId, outcome.token)) {
        ctx.logger.debug('browser discarded a stale picker callback', { tabId })

        return
      }

      ensureTabs().setPicking(null)

      if (outcome.kind === 'submitted') {
        const contents = ensureTabs().contentsOf(tabId)
        const picked: PickedElement = {
          tabId,
          url: contents?.getURL() ?? '',
          submission: outcome.submission,
          elementType: outcome.element.elementType,
          comment: outcome.element.comment,
          report: outcome.element.report,
        }

        ctx.rpc.emit('browser.elementPicked', picked)
      }
    }

    function startPick(tabId: number, theme: 'light' | 'dark'): void {
      const active = ensureTabs()
      const contents = active.contentsOf(tabId)

      if (contents === null) {
        throw new AppError(browserErrors.tab_not_found, `标签 ${String(tabId)} 不存在`)
      }

      // 同时只租给一个标签：换标签拾取要先退掉上一个的面板，否则两套面板会各回各的载荷。
      const previous = picker.cancelActive()

      if (previous !== null) {
        cancelScript(previous.tabId)
      }

      const lease = picker.start(tabId)

      active.setPicking(tabId)
      injectPicker(contents, lease.token, theme, ctx.logger)
    }

    function cancelScript(tabId: number): void {
      const contents = tabs?.contentsOf(tabId) ?? null

      if (contents === null) {
        return
      }

      void contents
        .executeJavaScriptInIsolatedWorld(999, [{ code: 'window.__poieticaElementPicker?.cancel()' }])
        .catch(() => undefined)
    }

    ctx.rpc.handle('browser.state', () => stateOf())
    ctx.rpc.handle('browser.newTab', ({ url }) => {
      const id = ensureTabs().openTab(url)

      if (id === null) {
        throw new AppError(browserErrors.invalid_url, `无法识别的地址：${url ?? ''}`)
      }

      return stateOf()
    })
    ctx.rpc.handle('browser.closeTab', ({ tabId }) => {
      ensureTabs().closeTab(tabId)

      return stateOf()
    })
    ctx.rpc.handle('browser.selectTab', ({ tabId }) => {
      ensureTabs().selectTab(tabId)

      return stateOf()
    })
    ctx.rpc.handle('browser.reopenClosed', ({ index }) => {
      ensureTabs().reopenClosed(index)

      return stateOf()
    })
    ctx.rpc.handle('browser.navigate', ({ tabId, url }) => {
      ensureTabs().navigate(tabId, url)

      return stateOf()
    })
    ctx.rpc.handle('browser.back', ({ tabId }) => {
      ensureTabs().back(tabId)

      return {}
    })
    ctx.rpc.handle('browser.forward', ({ tabId }) => {
      ensureTabs().forward(tabId)

      return {}
    })
    ctx.rpc.handle('browser.reload', ({ tabId }) => {
      ensureTabs().reload(tabId)

      return {}
    })
    ctx.rpc.handle('browser.stop', ({ tabId }) => {
      ensureTabs().stop(tabId)

      return {}
    })
    ctx.rpc.handle('browser.setZoom', ({ tabId, level }) => {
      ensureTabs().setZoom(tabId, level)

      return {}
    })
    ctx.rpc.handle('browser.setBounds', ({ x, y, width, height }) => {
      ensureTabs().setBounds({ x, y, width, height })

      return {}
    })
    ctx.rpc.handle('browser.setVisible', ({ visible }) => {
      ensureTabs().setVisible(visible)

      return {}
    })
    ctx.rpc.handle('browser.pickElement', ({ tabId, theme }) => {
      startPick(tabId, theme)

      return {}
    })
    ctx.rpc.handle('browser.cancelPick', () => {
      const lease = picker.cancelActive()

      if (lease !== null) {
        cancelScript(lease.tabId)
        ensureTabs().setPicking(null)
      }

      return {}
    })

    ctx.lifecycle.onReady(() => {
      applySessionPolicy(session.fromPartition(BROWSER_PARTITION))

      const active = ensureTabs()
      const relay = createRelayClient(relayTabsPort(active), {
        logger: ctx.logger.child({ scope: 'relay' }),
      })

      /* Core 每次重启端口都可能变：ready 时用 supervisor.relayPort() 重新设置地址。relay 服务只在 omp 第一次用浏览器工具时才起，「连不上」是常态。 */
      const applyCoreStatus = (status: CoreStatus): void => {
        relay.setUrl(relayUrlForStatus(status.state, ctx.core.relayPort()))
      }

      ctx.disposables.add(ctx.core.onStatus(applyCoreStatus))
      applyCoreStatus(ctx.core.status())
      /* driven 说的是「真的在驾驶」：至少有一张标签挂着 AI 的调试器（B-04）。按 socket 连没连算是错的 —— relay 守护常驻，那条提示会一直亮着。 */
      ctx.disposables.add(
        relay.onAttachedChange((attachedTabIds) => {
          ensureTabs().setDriven(attachedTabIds.length > 0)
        }),
      )
      ctx.disposables.add(
        relay.onConnectedChange((connected) => {
          ctx.logger.debug('browser relay connection changed', { connected })
        }),
      )
      ctx.disposables.add(
        active.onState((state) => {
          relay.publish(state)
          ctx.rpc.emit('browser.stateChanged', state)
        }),
      )
      ctx.lifecycle.onShutdown(() => {
        relay.dispose()
        ensureTabs().disposeAll()
      })
    })
  },
})

function relayTabsPort(tabs: BrowserTabs): RelayTabsPort {
  return {
    state: () => tabs.state(),
    contentsOf: (tabId) => tabs.contentsOf(tabId),
    openTab: (url, active) => tabs.openTab(url, active),
    closeTab: (tabId) => {
      tabs.closeTab(tabId)
    },
    selectTab: (tabId) => {
      tabs.selectTab(tabId)
    },
    userAgent: () => session.fromPartition(BROWSER_PARTITION).getUserAgent(),
    browserVersion: () => `Chrome/${process.versions.chrome ?? '0'}`,
  }
}

function viewHostOf(win: ReturnType<WindowRegistry['main']>, _logger: Logger) {
  return {
    createView(): WebContentsViewLike {
      return new WebContentsView({
        webPreferences: { ...BROWSER_VIEW_PREFERENCES },
      }) as unknown as WebContentsViewLike
    },
    attach(view: WebContentsViewLike): void {
      win.contentView.addChildView(view as unknown as WebContentsView)
    },
    detach(view: WebContentsViewLike): void {
      win.contentView.removeChildView(view as unknown as WebContentsView)
    },
    zoomFactor(): number {
      return win.webContents.getZoomFactor()
    },
    onResize(fn: () => void) {
      win.on('resize', fn)

      return {
        dispose: () => {
          win.off('resize', fn)
        },
      }
    },
  }
}

/** 注入拾取脚本：先整份脚本，再下这一轮的 start（顺序反了页面里还没有那个对象）。 */
function injectPicker(contents: WebContentsLike, token: string, theme: 'light' | 'dark', logger: Logger): void {
  const args = { token, theme, callbackUrl: PICKER_CALLBACK_URL }
  const code = `(${pickerRuntime.toString()})(${JSON.stringify(args)});`

  void contents.executeJavaScriptInIsolatedWorld(999, [{ code }]).catch((cause: unknown) => {
    logger.warn('browser picker injection failed', { error: String(cause) })
  })
}
