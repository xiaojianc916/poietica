import { Button, Switch } from '@poietica/design-system'
import { COMPUTER_USE, type ComputerUse, computerUse, type PluginStore } from '@poietica/extension'
import { assertUnreachable } from '@poietica/problem'
import { useEffect, useSyncExternalStore } from 'react'
import { SettingRow, SettingsGroup, SettingsPage } from './surface/settings-primitives'

const LABEL = 'Kimi Computer Use'
const UNREAD = '正在读取本机 Kimi 的安装状态…'
const UNLISTED = '当前 Kimi 版本没有提供这项能力。'
const UNSUPPORTED = '这台电脑不支持这项能力。'
const INSTALLING = '正在安装 Kimi Computer Use…'
const INSTALLABLE = '让它看屏幕、移动鼠标、敲键盘替你操作这台电脑。'
const REPAIRABLE = '安装不完整，修复后即可使用。'
const READY = '已就绪。'
const ENABLED = '已开启。'
const DISABLED = '已关闭。'

const FAILURE_PREFIX = '安装失败：'

export function computerUseFailureDescription(reason: string): string {
  const detail = reason.trim().replace(/^(?:安装失败[：:]\s*)+/u, '')

  return `${FAILURE_PREFIX}${detail === '' ? 'Kimi Code 未提供失败原因。' : detail}`
}

export interface ComputerUseSettingsProps {
  readonly store: PluginStore
}

export function ComputerUseSettings({ store }: ComputerUseSettingsProps) {
  const state = computerUse(useSyncExternalStore(store.subscribe, store.getSnapshot))

  useEffect(() => {
    store.refreshCapabilities()
  }, [store])

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
    case 'unavailable':
      return `无法启动本机 Kimi：${state.reason}`
    case 'unlisted':
      return UNLISTED
    case 'unsupported':
      return UNSUPPORTED
    case 'installing':
      return INSTALLING
    case 'failed':
      return computerUseFailureDescription(state.reason)
    case 'installable':
      return INSTALLABLE
    case 'repairable':
      return REPAIRABLE
    case 'ready':
      return READY
    case 'installed':
      return state.enabled ? ENABLED : DISABLED
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
    case 'unavailable':
      return (
        <Button onClick={store.refreshCapabilities} size="xs" type="button" variant="soft">
          重试
        </Button>
      )
    case 'installable':
    case 'repairable':
    case 'failed':
      return (
        <Button
          onClick={() => store.installCapability(COMPUTER_USE.capabilityId)}
          size="xs"
          type="button"
          variant="soft"
        >
          {state.kind === 'installable' ? '安装' : state.kind === 'repairable' ? '修复' : '重试'}
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
    case 'unlisted':
    case 'unsupported':
    case 'ready':
      return null
    default:
      return assertUnreachable(state)
  }
}
