import { Button, Select, type SelectOption, Switch } from '@poietica/design-system'
import { COMPUTER_USE, type ComputerUse, computerUse, type PluginStore } from '@poietica/extension'
import { assertUnreachable } from '@poietica/problem'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { SettingRow, SettingsGroup, SettingsPage, ToggleRow } from './surface/settings-primitives'

const LABEL = 'Kimi Computer Use'
const UNREAD = '正在读取本机 Kimi 的安装状态…'
const UNLISTED = '当前 Kimi 版本没有提供这项能力'
const UNSUPPORTED = '这台电脑不支持这项能力'
const INSTALLING = '正在安装 Kimi Computer Use…'
const INSTALLABLE = '让它看屏幕、移动鼠标、敲键盘替你操作这台电脑'
const REPAIRABLE = '安装不完整，修复后即可使用'
const READY = '已就绪'
const ENABLED = '已开启'
const DISABLED = '已关闭'

const FAILURE_PREFIX = '安装失败：'

/* 纯 UI 占位：值是字面量，后端接入时换成真实枚举（同 settings-surface.tsx 的 COLOR_MODES 写法）。 */
const URL_OPEN_TARGETS: readonly SelectOption<string>[] = [
  { value: 'system', label: '默认浏览器' },
  { value: 'builtin', label: '内置浏览器' },
]

const LOCAL_URL_OPEN_TARGETS: readonly SelectOption<string>[] = [
  { value: 'builtin', label: '内置浏览器' },
  { value: 'system', label: '默认浏览器' },
]

const ANNOTATION_MODES: readonly SelectOption<string>[] = [
  { value: 'always', label: '始终包含' },
  { value: 'ask', label: '询问' },
  { value: 'never', label: '不包含' },
]

const HISTORY_ACCESS_MODES: readonly SelectOption<string>[] = [
  { value: 'ask', label: '始终询问' },
  { value: 'allow', label: '始终允许' },
  { value: 'deny', label: '不允许' },
]

/* 占位：按钮尚未接后端，点击不做事。 */
const noop = () => {}

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

  /* 纯 UI 占位，状态留本地；后端接入时换成真实 store 读写并删掉此 useState。 */
  const [browser, setBrowser] = useState({
    enabled: true,
    urlOpenTarget: 'system',
    localUrlOpenTarget: 'builtin',
    showFullUrl: false,
    annotation: 'always',
    askBeforeDownload: false,
    historyAccess: 'ask',
    siteTools: true,
  })
  const patchBrowser = (patch: Partial<typeof browser>) =>
    setBrowser((current) => ({ ...current, ...patch }))

  return (
    <SettingsPage>
      <SettingsGroup>
        <SettingRow description={describe(state)} label={LABEL}>
          <Control state={state} store={store} />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup>
        <SettingRow description="让 Poietica 控制内置浏览器" label="浏览器">
          <Switch
            aria-label="浏览器"
            checked={browser.enabled}
            onCheckedChange={(enabled) => patchBrowser({ enabled })}
            size="sm"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        headerAction={
          <Button onClick={noop} size="xs" type="button" variant="soft">
            导入
          </Button>
        }
        title="常规"
      >
        <SettingRow description="链接默认打开位置" label="网页 URL 和链接打开位置">
          <Select
            align="end"
            className="settings-select-trigger"
            data={URL_OPEN_TARGETS}
            onValueChange={(urlOpenTarget) => patchBrowser({ urlOpenTarget })}
            type="网页 URL 和链接打开位置"
            value={browser.urlOpenTarget}
          />
        </SettingRow>

        <SettingRow description="本地开发站点默认打开位置" label="本地 URL 打开位置">
          <Select
            align="end"
            className="settings-select-trigger"
            data={LOCAL_URL_OPEN_TARGETS}
            onValueChange={(localUrlOpenTarget) => patchBrowser({ localUrlOpenTarget })}
            type="本地 URL 打开位置"
            value={browser.localUrlOpenTarget}
          />
        </SettingRow>

        <ToggleRow
          checked={browser.showFullUrl}
          description="在地址栏中显示路径、查询参数和片段"
          label="显示完整网址"
          onChange={(showFullUrl) => patchBrowser({ showFullUrl })}
        />

        <SettingRow
          description="清除应用内浏览器中的浏览历史、网站数据、缓存和下载历史记录"
          label="浏览数据"
        >
          <Button onClick={noop} size="xs" type="button" variant="soft">
            清除浏览数据
          </Button>
        </SettingRow>

        <SettingRow description="查看和管理在内置浏览器中访问过的页面" label="浏览历史">
          <Button onClick={noop} size="xs" type="button" variant="soft">
            管理
          </Button>
        </SettingRow>

        <SettingRow
          description="截图可帮助 Poietica 更好地理解和处理页面，但会增加用量"
          label="批注截图"
        >
          <Select
            align="end"
            className="settings-select-trigger"
            data={ANNOTATION_MODES}
            onValueChange={(annotation) => patchBrowser({ annotation })}
            type="批注截图"
            value={browser.annotation}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="自动填充和密码">
        <SettingRow description="添加、删除和编辑已保存的密码" label="密码管理器">
          <Button onClick={noop} size="xs" type="button" variant="soft">
            管理
          </Button>
        </SettingRow>

        <SettingRow
          description="添加、删除和编辑已保存的地址、电话号码和电子邮箱地址"
          label="联系信息"
        >
          <Button onClick={noop} size="xs" type="button" variant="soft">
            管理
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="下载">
        <SettingRow description="系统下载文件夹" label="位置">
          <Button onClick={noop} size="xs" type="button" variant="soft">
            更改
          </Button>
        </SettingRow>

        <ToggleRow
          checked={browser.askBeforeDownload}
          description="对在内置浏览器中发起的下载显示保存对话框"
          label="下载前询问保存位置"
          onChange={(askBeforeDownload) => patchBrowser({ askBeforeDownload })}
        />

        <SettingRow description="查看和管理从内置浏览器下载的文件" label="下载历史记录">
          <Button onClick={noop} size="xs" type="button" variant="soft">
            管理
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="浏览器权限">
        <SettingRow description="管理内置浏览器中的摄像头和麦克风权限" label="网站设置">
          <Button onClick={noop} size="xs" type="button" variant="soft">
            管理
          </Button>
        </SettingRow>

        <SettingRow description="选择 Poietica 是否可访问你的内置浏览器历史记录" label="历史记录">
          <Select
            align="end"
            className="settings-select-trigger"
            data={HISTORY_ACCESS_MODES}
            onValueChange={(historyAccess) => patchBrowser({ historyAccess })}
            type="历史记录"
            value={browser.historyAccess}
          />
        </SettingRow>

        <ToggleRow
          checked={browser.siteTools}
          description="允许 Poietica 发现并调用网站公开的站点工具，包括 WebMCP"
          label="启用站点工具"
          onChange={(siteTools) => patchBrowser({ siteTools })}
        />
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
