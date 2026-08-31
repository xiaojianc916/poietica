import { Button, Switch } from '@poietica/design-system'
import {
  type ComputerUseView,
  computerUseView,
  KIMI_COMPUTER_USE,
  KIMI_COMPUTER_USE_SOURCE,
  type PluginStore,
} from '@poietica/extension'
import { assertUnreachable } from '@poietica/problem'
import { useSyncExternalStore } from 'react'
import { SettingRow, SettingsGroup, SettingsPage } from './surface/settings-primitives'

/*
 * 电脑控制那一行。
 *
 * 状态与动作都落在 PluginStore 那一份账上，这里没有本地态，所以不存在「界面说开着、
 * 账本说关着」。关闭只拨插件总开关：官方能力面没有停用接口，而单台 MCP 的开关归扩展页，
 * 不在这里被悄悄改写。
 */

const LABEL = 'Kimi Computer Use'

const ABSENT = '装上官方插件 Kimi Computer Use，让它看屏幕、移动鼠标、敲键盘替你操作这台电脑。'

const ENABLED = '已开启：新开的会话可以操作这台电脑的屏幕、鼠标与键盘。'

const DISABLED = '已关闭：会话不装载它，也就碰不到屏幕、鼠标与键盘。'

const PARTIAL = '已开启，但它带来的 MCP 服务器在扩展页被单独关掉了；再拨一次开关会一并打开。'

export interface ComputerUseSettingsProps {
  readonly store: PluginStore
}

export function ComputerUseSettings({ store }: ComputerUseSettingsProps) {
  const state = computerUseView(useSyncExternalStore(store.subscribe, store.getSnapshot))

  return (
    <SettingsPage>
      <SettingsGroup>
        <SettingRow description={describe(state)} label={LABEL}>
          <Control state={state} store={store} />
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  )
}

function describe(state: ComputerUseView): string {
  switch (state.kind) {
    case 'absent':
      return ABSENT
    case 'installing':
      return '正在下载并解压官方插件…'
    case 'confirming': {
      const version = state.version === undefined ? '' : ` ${state.version}`

      return `要装的是官方插件 ${state.displayName}${version}。`
    }
    case 'refused':
      return state.reason
    case 'installed':
      if (!state.enabled) {
        return DISABLED
      }

      return state.needsEnabling.length === 0 ? ENABLED : PARTIAL
    default:
      return assertUnreachable(state)
  }
}

interface ControlProps {
  readonly state: ComputerUseView
  readonly store: PluginStore
}

function Control({ state, store }: ControlProps) {
  switch (state.kind) {
    case 'absent':
    case 'refused':
      return (
        <Button
          onClick={() => {
            store.beginInstall(KIMI_COMPUTER_USE_SOURCE)
          }}
          size="xs"
          type="button"
          variant="soft"
        >
          {state.kind === 'absent' ? '安装' : '重试'}
        </Button>
      )
    case 'installing':
      return (
        <Button onClick={store.cancelInstall} size="xs" type="button" variant="ghost">
          取消
        </Button>
      )
    case 'confirming':
      return (
        <>
          <Button onClick={store.cancelInstall} size="xs" type="button" variant="ghost">
            取消
          </Button>

          <Button onClick={store.confirmInstall} size="xs" type="button" variant="soft">
            确认安装
          </Button>
        </>
      )
    case 'installed': {
      const { needsEnabling } = state

      return (
        <Switch
          aria-label={LABEL}
          checked={state.enabled}
          onCheckedChange={(next) => {
            store.setEnabled(KIMI_COMPUTER_USE.pluginId, next)

            if (!next) {
              return
            }

            for (const server of needsEnabling) {
              store.setMcpServerEnabled(server.origin, server.name, true)
            }
          }}
          size="sm"
        />
      )
    }
    default:
      return assertUnreachable(state)
  }
}
