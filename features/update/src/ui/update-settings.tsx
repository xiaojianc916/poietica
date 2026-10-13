import { SettingsGroup, ToggleRow } from '@poietica/design-system'
import type { PreferencesApi } from '@poietica/feature-preferences/ui-api'
import { useObservable } from '@poietica/ui-kernel'
import type { ReactElement } from 'react'

/* 「软件更新」那一组落在**关于页**里。组件只输出 SettingsGroup（页面骨架由 platform 的 AboutPage 给），所以它不是一页、只是一段 ——
 * 落在 `builtinPoints.settingsSections` 的 `page: 'platform.about'` 上。产品负责人 2026-10-08：这一组只留**一个开关**（「自动检查软件
 * 更新」，默认开）；当前版本 / 上次检查 / 「检查更新」按钮那几行从关于页撤掉 —— 手动检查是帮助菜单里 `UpdateRow` 的事。 */
export function UpdateAboutGroup({ preferences }: { readonly preferences: PreferencesApi }): ReactElement {
  /* 开关读的是偏好本身：`PreferencesApi` 有 current() + subscribe，直接交给 useObservable。只读 current() 不订阅的话，点一下开关
   * 视觉上不会动。 */
  const preferencesValue = useObservable(preferences)
  return (
    <SettingsGroup title="诊断与更新">
      <ToggleRow
        checked={preferencesValue.updates.autoCheck}
        description="启动时向更新服务查询新版本"
        label="自动检查软件更新"
        onChange={(checked) => {
          void preferences.update({ updates: { autoCheck: checked } })
        }}
      />
    </SettingsGroup>
  )
}
