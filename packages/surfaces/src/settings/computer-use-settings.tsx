import { Button, Switch } from '@poietica/design-system'
import {
  COMPUTER_USE,
  type ComputerUse,
  type ComputerUseStep,
  computerUse,
  type PluginStore,
} from '@poietica/extension'
import { assertUnreachable } from '@poietica/problem'
import { useSyncExternalStore } from 'react'
import { SettingRow, SettingsGroup, SettingsPage } from './surface/settings-primitives'

/*
 * 电脑控制那一行。
 *
 * 装到哪一步由本机 kap 说，开没开由本机账本说；这里两样都不留副本，也不自己下载任何
 * 东西。文案不替运行时背书：还差哪一层就说哪一层。
 */

const LABEL = 'Kimi Computer Use'

const UNREAD = '正在问本机 Kimi 这项能力装到哪一步…'

const UNREACHABLE = '本机 Kimi 还没连上。开一条对话之后，这里会显示它装到哪一步。'

const UNLISTED = '本机 Kimi 没有报告这项能力。'

const UNSUPPORTED = '这台电脑不支持这项能力。'

const INSTALLING = '正在让本机 Kimi 安装，装完这里会逐层显示就绪度…'

const ENABLED = '已开启：新开的会话会装载它，屏幕、鼠标与键盘都归它。'

const DISABLED = '已关闭：会话不装载它，也就碰不到屏幕、鼠标与键盘。'

const UNMANAGED = '已就绪。这一份不在本机账本里，所以这里没有开关。'

const PITCH = '让它看屏幕、移动鼠标、敲键盘替你操作这台电脑。'

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

function missing(steps: readonly ComputerUseStep[]): string {
  return steps
    .filter((step) => !step.satisfied)
    .map((step) => step.label)
    .join('、')
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
    case 'refused':
      return state.reason
    case 'incomplete':
      return `还差：${missing(state.steps)}。${PITCH}`
    case 'ready':
      if (state.enabled === undefined) {
        return UNMANAGED
      }

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
    case 'incomplete':
    case 'refused':
      return (
        <Button
          onClick={() => {
            store.installCapability(COMPUTER_USE.capabilityId)
          }}
          size="xs"
          type="button"
          variant="soft"
        >
          {state.kind === 'incomplete' ? '安装' : '重试'}
        </Button>
      )
    case 'ready':
      if (state.enabled === undefined) {
        return null
      }

      return (
        <Switch
          aria-label={LABEL}
          checked={state.enabled}
          onCheckedChange={(next) => {
            store.setEnabled(COMPUTER_USE.pluginId, next)
          }}
          size="sm"
        />
      )
    case 'unread':
    case 'unreachable':
    case 'unlisted':
    case 'unsupported':
    case 'installing':
      return null
    default:
      return assertUnreachable(state)
  }
}
