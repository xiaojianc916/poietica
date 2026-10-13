import { SettingRow, SettingsGroup, SettingsPage, ToggleRow } from '@poietica/design-system'
import { type ReactElement, useEffect, useState } from 'react'
import type { Capabilities } from '../contract'
import type { AgentSettingsApi } from './api'

/* 电脑控制与浏览器控制两个开关，各附一段风险说明。两格的说明句取 legacy 原文，风险语气照旧。随新架构收敛的一处：legacy 那一页背后是
 * PluginStore 与四档安装态，那是「由原生侧安装 omp 能力」的方案；新架构里能力就是 agent 自己的两个设置项，没有安装这一步，所以只剩开关本身。 */

const RISK: Readonly<Record<keyof Capabilities, { readonly label: string; readonly description: string }>> = {
  computerUse: {
    label: '电脑操控',
    // 说明句取自 legacy 的 INSTALLABLE。
    description: '让它看屏幕、移动鼠标、敲键盘替你操作这台电脑',
  },
  browserControl: {
    label: '浏览器控制',
    // 说明句取自 legacy 浏览器那一格。
    description: '让 agent 用它自带的浏览器打开和操作网页',
  },
}

export function CapabilitiesPage({ api }: { readonly api: AgentSettingsApi }): ReactElement {
  const [caps, setCaps] = useState<Capabilities | null>(null)

  useEffect(() => {
    void api
      .capabilities()
      .then(setCaps)
      .catch(() => undefined)
  }, [api])

  return (
    <SettingsPage>
      <SettingsGroup title="能力">
        {(Object.keys(RISK) as (keyof Capabilities)[]).map((name) =>
          caps === null ? (
            <SettingRow description={RISK[name].description} key={name} label={RISK[name].label} />
          ) : (
            <ToggleRow
              checked={caps[name]}
              description={RISK[name].description}
              key={name}
              label={RISK[name].label}
              onChange={(next: boolean) => {
                void api
                  .setCapability(name, next)
                  .then(setCaps)
                  .catch(() => undefined)
              }}
            />
          ),
        )}
      </SettingsGroup>
    </SettingsPage>
  )
}
