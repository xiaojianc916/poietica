import { Button, Switch } from '@poietica/design-system'
import { COMPUTER_USE, type ComputerUse, computerUse, type PluginStore } from '@poietica/extension'
import { assertUnreachable } from '@poietica/problem'
import { useSyncExternalStore } from 'react'
import { SettingRow, SettingsGroup, SettingsPage } from './surface/settings-primitives'

const LABEL = 'Kimi Computer Use'
const UNREAD = '正在读取本机 Kimi 的安装状态…'
const UNREACHABLE = '本机 Kimi 尚未连接，连接后即可安装。'
const UNLISTED = '当前 Kimi 版本没有提供这项能力。'
const UNSUPPORTED = '这台电脑不支持这项能力。'
const INSTALLING = '正在安装 Kimi Computer Use…'
const INSTALLABLE = '让它看屏幕、移动鼠标、敲键盘替你操作这台电脑。'
const ENABLED = '已开启。'
const DISABLED = '已关闭。'

export interface ComputerUseSettingsProps {
  readonly store: PluginStore
}

export function ComputerUseSettings({ store }: ComputerUseSettingsProps) {
  const state = computerUse(useSyncExternalStore(store.subscribe, store.getSnapshot))
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

function describe(state: ComputerUse): string {
  switch (state.kind) {
    case 'unread':
      return UNREAD
    case 'unreachable':
      return UNREACHABLE
    case 'unlisted':
      return UNLISTED
    case 'unsupported':
      return UNSUPPORTED
    case 'installing':
      return INSTALLING
    case 'failed':
      return `安装失败：${state.reason}`
    case 'installable':
      return INSTALLABLE
    case 'installed': {
      const verdict = state.enabled ? ENABLED : DISABLED
      return state.issue === undefined ? verdict : `${verdict} ${state.issue}`
    }
    default:
      return assertUnreachable(state)
  }
}

interface ControlProps {
  readonly state: ComputerUse
  readonly store: PluginStore
}

function Control({ state, store }: ControlProps) {
  switch (state.kind) {
    case 'installable':
    case 'failed':
      return (
        <Button
          onClick={() => store.installCapability(COMPUTER_USE.capabilityId)}
          size="xs"
          type="button"
          variant="soft"
        >
          {state.kind === 'installable' ? '安装' : '重试'}
        </Button>
      )
    case 'installing':
      return (
        <Button disabled size="xs" type="button" variant="soft">
          安装中
        </Button>
      )
    case 'installed':
      return (
        <Switch
          aria-label={LABEL}
          checked={state.enabled}
          onCheckedChange={(next) => store.setEnabled(state.pluginId, next)}
          size="sm"
        />
      )
    case 'unread':
    case 'unreachable':
    case 'unlisted':
    case 'unsupported':
      return null
    default:
      return assertUnreachable(state)
  }
}
