import { Button, Select, SettingRow, SettingsGroup, SettingsPage, ToggleRow } from '@poietica/design-system'
import {
  builtinPoints,
  FeatureScope,
  type KeybindingService,
  KeybindingsToken,
  useContributions,
  useService,
} from '@poietica/ui-kernel'
import { type ReactElement, useCallback, useEffect, useState } from 'react'
import type { Preferences } from '../contract'
import type { PreferencesRpcApi } from './api'

/*
 * 三个设置页。**迁移自** legacy `settings-surface.tsx` 的 GeneralSettings /
 * AppearanceSettings / KeymapSettings：分组名、行标签、说明文案、选项表（含顺序与
 * 措辞）逐条照旧；排版词汇取自 design-system 的 settings-primitives。
 *
 * 只改数据来源：legacy 读 settings store 的 controller.update，这里读 preferences 的
 * 契约方法。
 */

/*
 * 静态选项表，与 legacy 同名同序。顺序是产品定的，不重排
 * （legacy 里「跟随系统」在最后、密度「宽松」在前）。
 */
const COLOR_MODES = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
] as const

const LANGUAGES = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en', label: 'English' },
] as const

const DENSITIES = [
  { value: 'comfortable', label: '宽松' },
  { value: 'compact', label: '紧凑' },
] as const

function usePrefs(
  api: PreferencesRpcApi,
): [Preferences | null, (patch: Parameters<PreferencesRpcApi['update']>[0]) => void, (next: Preferences) => void] {
  const [prefs, setPrefs] = useState<Preferences | null>(null)
  useEffect(() => {
    let cancelled = false
    void api.get().then((p) => {
      if (!cancelled) setPrefs(p)
    })
    return () => {
      cancelled = true
    }
  }, [api])
  const update = (patch: Parameters<PreferencesRpcApi['update']>[0]): void => {
    void api.update(patch).then((next) => setPrefs(next))
  }
  return [prefs, update, setPrefs]
}

/** 初始值：与契约里每格的 default 一致（「恢复默认」写回去的就是这一份） */
const DEFAULT_PREFERENCES = {
  theme: 'system',
  language: 'zh-CN',
  general: { sendWithModifier: false, confirmBeforeDelete: true, notifyOnCompletion: true },
  appearance: { density: 'comfortable', reduceMotion: false, messageTimestamps: false },
} as const

/**
 * 落在某一页里的**别的功能**贡献的那些组（builtinPoints.settingsSections）。
 *
 * legacy 的通用页里住着 Python 内核那一组（07 页 §13G 原设计是独立一页，产品负责人
 * 2026-10-06 改成并入通用页）。`page` 是字符串，所以这里不 import python 功能（守则 3）；
 * 每一段用 FeatureScope 包住，贡献者的组件仍然按它自己的功能 id 取服务。
 */
function PageSections({ page }: { readonly page: string }): ReactElement | null {
  const sections = useContributions(builtinPoints.settingsSections).filter((c) => c.item.page === page)

  if (sections.length === 0) return null

  return (
    <>
      {sections.map(({ featureId, item }) => {
        const Component = item.component

        return (
          <FeatureScope featureId={featureId} key={item.id}>
            <Component />
          </FeatureScope>
        )
      })}
    </>
  )
}

/**
 * 通用页：对话 / 安全（本功能拥有的两组）+ 别的功能搬进来的「运行时」等组 + 重置。
 * 分组次序照 legacy GeneralSettings：对话 → 启动项 → 安全 → 运行时 → 重置
 * （「启动项」那组要 `general.daemon`，新契约的 general 没有这个字段 —— 见
 * docs/refactor-log.md 的待决问题 Q22，不编数据）。
 */
export function GeneralPage({ api }: { readonly api: PreferencesRpcApi }): ReactElement {
  const [prefs, update, setPrefs] = usePrefs(api)
  const [resetting, setResetting] = useState(false)
  if (prefs === null) return <SettingsPage />

  return (
    <SettingsPage>
      <SettingsGroup title="对话">
        <ToggleRow
          checked={prefs.general.sendWithModifier}
          description="开启后 Enter 换行，Ctrl / ⌘ + Enter 发送；关闭时相反"
          label="用修饰键发送"
          onChange={(checked) => update({ general: { sendWithModifier: checked } })}
        />

        <ToggleRow
          checked={prefs.general.notifyOnCompletion}
          description="长任务结束时发一条系统通知；窗口在前台时只留屏幕上那一条"
          label="完成时通知"
          onChange={(checked) => update({ general: { notifyOnCompletion: checked } })}
        />
      </SettingsGroup>

      <SettingsGroup title="安全">
        <ToggleRow
          checked={prefs.general.confirmBeforeDelete}
          description="删除对话前再确认一次"
          label="删除前确认"
          onChange={(checked) => update({ general: { confirmBeforeDelete: checked } })}
        />
      </SettingsGroup>

      <PageSections page="preferences.general" />

      {/*
       * 「重置」组（legacy 通用页的最后一组）。契约里没有 prefs.reset —— 那与
       * prefs.update 的语义重复（改成初始值就是一次覆盖写），所以这里把默认值整份写回去，
       * 界面与文案照 legacy：一句说明 + 一枚「恢复默认」。
       */}
      <SettingsGroup title="重置">
        <SettingRow description="把全部设置项还原为初始值" label="恢复默认设置">
          <Button
            disabled={resetting}
            onClick={() => {
              setResetting(true)
              void api
                .update(DEFAULT_PREFERENCES)
                .then((next) => {
                  setPrefs(next)
                })
                .finally(() => {
                  setResetting(false)
                })
            }}
            size="xs"
            type="button"
            variant="soft"
          >
            {resetting ? '正在恢复…' : '恢复默认'}
          </Button>
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  )
}

/** 外观页：主题与语言 / 界面（legacy AppearanceSettings 的两个分组） */
export function AppearancePage({ api }: { readonly api: PreferencesRpcApi }): ReactElement {
  const [prefs, update] = usePrefs(api)
  if (prefs === null) return <SettingsPage />

  return (
    <SettingsPage>
      <SettingsGroup title="主题与语言">
        <SettingRow description="浅色、深色或跟随系统" label="颜色模式">
          <Select
            align="end"
            className="settings-select-trigger"
            data={[...COLOR_MODES]}
            onValueChange={(v) => update({ theme: v as Preferences['theme'] })}
            type="颜色模式"
            value={prefs.theme}
          />
        </SettingRow>

        <SettingRow description="界面文案使用的语言" label="界面语言">
          <Select
            align="end"
            className="settings-select-trigger"
            data={[...LANGUAGES]}
            onValueChange={(v) => update({ language: v as Preferences['language'] })}
            type="界面语言"
            value={prefs.language}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="界面">
        <SettingRow description="列表与消息之间的留白" label="显示密度">
          <Select
            align="end"
            className="settings-select-trigger"
            data={[...DENSITIES]}
            onValueChange={(v) => update({ appearance: { density: v as 'comfortable' | 'compact' } })}
            type="显示密度"
            value={prefs.appearance.density}
          />
        </SettingRow>

        <ToggleRow
          checked={prefs.appearance.reduceMotion}
          description="关掉过渡与位移动画，只保留状态变化"
          label="减少动效"
          onChange={(checked) => update({ appearance: { reduceMotion: checked } })}
        />

        <ToggleRow
          checked={prefs.appearance.messageTimestamps}
          description="在每条消息旁显示发生时间"
          label="消息时间戳"
          onChange={(checked) => update({ appearance: { messageTimestamps: checked } })}
        />
      </SettingsGroup>

      <MascotPrefsGroup api={api} />
    </SettingsPage>
  )
}

/*
 * 吉祥物的两个开关。**迁移**自 legacy \`settings-surface/mascot-prefs.tsx\`：
 * 分组名、标签、说明、默认值（都是 true）一字未改；换掉的只有存放处 ——
 * legacy 把这两格放在渲染层的偏好文件里（\`@poietica/external-store\` 的 createPreference），
 * 新架构里渲染层记忆的正主是 \`uiState\`（preferences 契约的 uiState.get/set）。
 */
function MascotPrefsGroup({ api }: { readonly api: PreferencesRpcApi }): ReactElement {
  const [tour, setTour] = useState(true)
  const [follow, setFollow] = useState(true)

  useEffect(() => {
    let cancelled = false
    void api.uiStateGet('mascot.autoTour').then((v) => {
      if (!cancelled && typeof v === 'boolean') setTour(v)
    })
    void api.uiStateGet('mascot.followPointer').then((v) => {
      if (!cancelled && typeof v === 'boolean') setFollow(v)
    })
    return () => {
      cancelled = true
    }
  }, [api])

  return (
    <SettingsGroup title="吉祥物">
      <ToggleRow
        checked={tour}
        description="欢迎页的吉祥物自动在各个场景之间巡演"
        label="自动巡演"
        onChange={(value) => {
          setTour(value)
          void api.uiStateSet('mascot.autoTour', value)
        }}
      />

      <ToggleRow
        checked={follow}
        description="吉祥物的目光与身体跟随鼠标指针"
        label="跟随指针"
        onChange={(value) => {
          setFollow(value)
          void api.uiStateSet('mascot.followPointer', value)
        }}
      />
    </SettingsGroup>
  )
}

/** 快捷键页：全部命令 + 当前按键 + 录制 + 恢复默认（legacy keymap-settings 的同一件事） */
export function KeymapPage({ api }: { readonly api: PreferencesRpcApi }): ReactElement {
  const keybindings = useService(KeybindingsToken) as KeybindingService
  const commands = useContributions(builtinPoints.commands)
  const [overrides, setOverrides] = useState<Record<string, string | null>>({})
  const [recording, setRecording] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api.keymapGet().then((o) => {
      if (!cancelled) setOverrides(o)
    })
    const sub = api.onKeymapChanged((o) => setOverrides(o))
    return () => {
      cancelled = true
      sub.dispose()
    }
  }, [api])

  useEffect(() => {
    keybindings.setOverrides(overrides)
  }, [keybindings, overrides])

  const record = useCallback(
    (commandId: string) => {
      setRecording(commandId)
      const onKeyDown = (e: KeyboardEvent): void => {
        e.preventDefault()
        e.stopPropagation()
        if (e.key === 'Escape') {
          window.removeEventListener('keydown', onKeyDown, { capture: true })
          setRecording(null)
          return
        }
        const key = keybindings.normalize(e)
        if (key === null) return
        window.removeEventListener('keydown', onKeyDown, { capture: true })
        setRecording(null)
        void api.keymapSet(commandId, key).then((o) => {
          setOverrides(o)
          keybindings.setOverrides(o)
        })
      }
      window.addEventListener('keydown', onKeyDown, { capture: true })
    },
    [api, keybindings],
  )

  const visible = commands.filter((c) => c.item.hidden !== true)
  return (
    <SettingsPage>
      <SettingsGroup
        headerAction={
          <Button
            data-keymap-reset
            onClick={() => {
              void api.keymapReset().then((o) => {
                setOverrides(o)
                keybindings.setOverrides(o)
              })
            }}
            size="xs"
            type="button"
            variant="soft"
          >
            恢复默认
          </Button>
        }
        title="全部命令"
      >
        {visible.map((c) => (
          <SettingRow
            description={c.item.category === undefined ? c.item.id : `${c.item.category} · ${c.item.id}`}
            key={c.item.id}
            label={c.item.title}
          >
            <Button
              data-keymap-record={c.item.id}
              onClick={() => record(c.item.id)}
              size="xs"
              type="button"
              variant="soft"
            >
              {recording === c.item.id ? '按下按键…' : (keybindings.keyFor(c.item.id) ?? '未绑定')}
            </Button>
          </SettingRow>
        ))}
      </SettingsGroup>
    </SettingsPage>
  )
}
