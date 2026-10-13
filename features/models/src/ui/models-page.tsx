import { PreferencesToken } from '@poietica/feature-preferences/ui-api'
import { useObservable, useService } from '@poietica/ui-kernel'
import { type ReactNode, useCallback, useEffect, useMemo } from 'react'
import type { ModelsApi } from './api'
import { createCatalogPort } from './catalog-port'
import { ModelCatalogStore } from './catalog-store'
import { ModelsSettings } from './models-settings'
import './models-settings.css'

/* 「模型」页的组合根。页面本体是 legacy 的 `ModelsSettings`（**逐字迁移**）。这里只做三件接线：数据来源换成 `catalog-store` + `catalog-port`；
 * 排序与隐藏读 `preferences.modelPicker.providerOrder` / `hiddenModels`；模型可见性写回改成契约的 `models.setEnabled`。 */
export function ModelsPage({ api }: { readonly api: ModelsApi }): ReactNode {
  const prefs = useService(PreferencesToken)
  const settings = useObservable(prefs)
  const store = useMemo(() => new ModelCatalogStore(createCatalogPort(api)), [api])

  useEffect(() => () => store.dispose(), [store])

  /* 那一格开关在 legacy 里的意思是「在输入框中显示这个模型」，写的是**偏好**里的隐藏表（hiddenModelAliases）。新架构照旧：写
   * preferences.modelPicker.hiddenModels，而 models 契约的 setEnabled 是「这一家模型启不启用」那件事，两者不是一个开关。 */
  const onModelVisibilityChange = useCallback(
    (alias: string, visible: boolean) => {
      const next = new Set(settings.modelPicker.hiddenModels)
      if (visible) next.delete(alias)
      else next.add(alias)
      void prefs.update({ modelPicker: { hiddenModels: [...next].sort() } })
    },
    [prefs, settings.modelPicker.hiddenModels],
  )

  return (
    <ModelsSettings
      hiddenModelAliases={settings.modelPicker.hiddenModels}
      modelCatalog={store}
      onModelVisibilityChange={onModelVisibilityChange}
      providerOrder={settings.modelPicker.providerOrder}
    />
  )
}
