import { Button, Select, type SelectOption, Switch } from '@poietica/design-system'
import {
  type BrowserControl,
  COMPUTER_USE,
  computerUse,
  type PluginStore,
} from '@poietica/extension'
import { assertUnreachable } from '@poietica/problem'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { SettingRow, SettingsGroup, SettingsPage, ToggleRow } from './settings-primitives'

const LABEL = 'Oh My Pi Computer Use'
const UNREAD = '正在读取本机 Oh My Pi 的安装状态…'
const UNLISTED = '当前 Oh My Pi 版本没有提供这项能力'
const UNSUPPORTED = '这台电脑不支持这项能力'
const INSTALLING = '正在切换 Oh My Pi Computer Use…'
const INSTALLABLE = '让它看屏幕、移动鼠标、敲键盘替你操作这台电脑'
const REPAIRABLE = '安装不完整，修复后即可使用'
const READY = '已开启；关掉它模型就不再持有这块能力'
const ENABLED = '已开启'
const DISABLED = '已关闭'

const FAILURE_PREFIX = '安装失败：'

const BROWSER_READING = '正在读取 agent 的浏览器控制设置…'
const BROWSER_MANAGED = 'agent 自己启动一个浏览器来操作网页'
const BROWSER_APP = 'agent 直接操控右侧栏的内置浏览器，页面就在你眼前'
const BROWSER_CDP = '附着到一个已经在跑的浏览器（CDP）'
const CDP_DEFAULT = 'http://127.0.0.1:9222'
const APP_MODE = 'app'

export function computerUseFailureDescription(reason: string): string {
  const detail = reason.trim().replace(/^(?:安装失败[：:]\s*)+/u, '')

  return `${FAILURE_PREFIX}${detail === '' ? 'Oh My Pi 未提供失败原因。' : detail}`
}

export interface ComputerUseSettingsProps {
  readonly store: PluginStore
}

export function ComputerUseSettings({ store }: ComputerUseSettingsProps) {
  const view = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const state = computerUse(view)
  const browser = view.browser

  useEffect(() => {
    store.refreshCapabilities()
    store.refreshBrowserSettings()
  }, [store])

  return (
    <SettingsPage>
      <SettingsGroup>
        <SettingRow description={describe(state)} label={LABEL}>
          <Control state={state} store={store} />
        </SettingRow>
      </SettingsGroup>

      <BrowserSection browser={browser} store={store} />
    </SettingsPage>
  )
}

/*
 * agent 的浏览器控制走它自己的内置能力（Puppeteer 驱动 Chromium）：这一页只把它
 * 的开关与连接方式摊出来，写的全是 agent 自己的设置，由它自己热重载。
 */
function BrowserSection({
  browser,
  store,
}: {
  readonly browser: BrowserControl
  readonly store: PluginStore
}) {
  if (browser.kind === 'unread') {
    return (
      <SettingsGroup title="浏览器">
        <SettingRow description={BROWSER_READING} label="浏览器控制" />
      </SettingsGroup>
    )
  }

  if (browser.kind === 'failed') {
    return (
      <SettingsGroup title="浏览器">
        <SettingRow description={browser.reason} label="浏览器控制">
          <Button
            onClick={() => store.refreshBrowserSettings()}
            size="xs"
            type="button"
            variant="soft"
          >
            重试
          </Button>
        </SettingRow>
      </SettingsGroup>
    )
  }

  /*
   * 三档：内置浏览器（relay，默认）/ 托管启动 / 附着到现成的 CDP。
   *
   * 顺序与 omp 的判档一致 —— relay 它就是优先于 cdpUrl 的（它的 resolveBrowserKind 先问
   * relay 再问 cdpUrl），所以这里也先看 relay。
   */
  const modes: readonly SelectOption<string>[] = [
    { value: APP_MODE, label: '内置浏览器' },
    { value: 'managed', label: '托管启动' },
    { value: 'cdp', label: '附着到现成浏览器' },
  ]
  const mode = browser.relay ? APP_MODE : browser.cdpUrl === null ? 'managed' : 'cdp'

  return (
    <SettingsGroup title="浏览器">
      <SettingRow description="让 agent 用它自带的浏览器打开和操作网页" label="浏览器控制">
        <Switch
          aria-label="浏览器控制"
          checked={browser.enabled}
          onCheckedChange={(enabled) => store.setBrowserSettings({ enabled })}
          size="sm"
        />
      </SettingRow>

      <ToggleRow
        checked={browser.headless}
        description="不显示浏览器窗口，在后台完成操作"
        label="无头模式"
        onChange={(headless) => store.setBrowserSettings({ headless })}
      />

      <SettingRow
        description={
          mode === 'managed' ? BROWSER_MANAGED : mode === APP_MODE ? BROWSER_APP : BROWSER_CDP
        }
        label="连接方式"
      >
        <Select
          align="end"
          className="settings-select-trigger"
          data={modes}
          onValueChange={(next) => {
            if (next === 'managed') {
              store.setBrowserSettings({ relay: false, cdpUrl: '' })
            } else if (next === APP_MODE) {
              /* 内置那一档只认 relay；cdpUrl 留着不动，切回来时用户原来的地址还在。 */
              store.setBrowserSettings({ relay: true })
            } else {
              store.setBrowserSettings({ relay: false, cdpUrl: CDP_DEFAULT })
            }
          }}
          type="连接方式"
          value={mode}
        />
      </SettingRow>

      {mode === 'cdp' ? <CdpUrlRow store={store} value={browser.cdpUrl ?? ''} /> : null}
    </SettingsGroup>
  )
}

function CdpUrlRow({ store, value }: { readonly store: PluginStore; readonly value: string }) {
  const [draft, setDraft] = useState(value)

  useEffect(() => {
    setDraft(value)
  }, [value])

  const commit = () => {
    if (draft.trim() !== value) {
      store.setBrowserSettings({ cdpUrl: draft })
    }
  }

  return (
    <SettingRow
      description="浏览器需带 --remote-debugging-port 启动；agent 从这个端点附着"
      label="CDP 地址"
    >
      <input
        className="settings-input"
        onBlur={commit}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit()
          }
        }}
        placeholder={CDP_DEFAULT}
        value={draft}
      />
    </SettingRow>
  )
}

function describe(state: ReturnType<typeof computerUse>): string {
  switch (state.kind) {
    case 'unread':
      return UNREAD
    case 'unavailable':
      return `无法启动本机 Oh My Pi：${state.reason}`
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
  readonly state: ReturnType<typeof computerUse>
  readonly store: PluginStore
}

/*
 * 这一格的控制件。
 *
 * `ready` 与 `installable` 都是**开关**，不是「安装」与「已就绪」两颗不同的东西：
 * omp 里桌面控制没有安装这一步（它是构建期编进来的 eval 前奏），只有开与关。
 * 把 ready 画成什么都不给，点开之后就再也关不掉 —— 一道单向门。
 *
 * `installed` 那一档（插件形态的安装）留着自己的开关：它走的是插件账本，与上面的
 * 能力开关不是同一件事。
 */
function Control({ state, store }: ControlProps) {
  switch (state.kind) {
    case 'unavailable':
      return (
        <Button onClick={store.refreshCapabilities} size="xs" type="button" variant="soft">
          重试
        </Button>
      )
    case 'installable':
      return (
        <Switch
          aria-label={LABEL}
          checked={false}
          onCheckedChange={(next) => store.installCapability(COMPUTER_USE.capabilityId, next)}
          size="sm"
        />
      )
    case 'ready':
      return (
        <Switch
          aria-label={LABEL}
          checked
          onCheckedChange={(next) => store.installCapability(COMPUTER_USE.capabilityId, next)}
          size="sm"
        />
      )
    case 'repairable':
    case 'failed':
      return (
        <Button
          onClick={() => store.installCapability(COMPUTER_USE.capabilityId, true)}
          size="xs"
          type="button"
          variant="soft"
        >
          {state.kind === 'repairable' ? '修复' : '重试'}
        </Button>
      )
    case 'installing':
      return (
        <Button disabled size="xs" type="button" variant="soft">
          切换中
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
      return null
    default:
      return assertUnreachable(state)
  }
}
