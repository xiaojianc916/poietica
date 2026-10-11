import { Select, SettingRow, SettingsGroup } from '@poietica/design-system'
import { useCallback, useEffect, useState } from 'react'
import type { ModelRef } from '../contract'
import type { ModelsApi } from './api'

/*
 * 「通用」页里的「生成标题的模型」这一格（omp 知识 #17）。
 *
 * 语义（产品负责人定的）：**不设置就用这条对话自己的模型**。
 *   - 选「跟随对话模型」= 清掉 omp 的 modelRoles.title（null 一路透传）；
 *   - 选了某一条 = 标题固定用它。
 *
 * 候选只列**已启用**的模型（与输入框选择器同一份目录，读 models.catalog）。
 * 放在 models 功能里而不是 preferences：模型目录是这一功能的事实（守则 3：跨功能只经契约）。
 */
const FOLLOW_CHAT = '__follow_chat__'

export function TitleModelGroup({ api }: { readonly api: ModelsApi }): React.ReactElement {
  const [current, setCurrent] = useState<ModelRef | null>(null)
  const [models, setModels] = useState<readonly { readonly ref: ModelRef; readonly label: string }[]>([])
  const [loaded, setLoaded] = useState(false)

  /*
   * 候选直接来自 Core 的 `models.titleModel`：那是引擎此刻**真正可用**的模型
   * （omp 的 getAvailable，与输入框的模型选择器、入口页草稿控件同一份事实）。
   *
   * 不在这里自己过滤：真机实测按 `providers.configured` 会把 models.yml 里定义的自定义
   * 服务商（key 写在 yml 里、凭据表里没有）判成没配置，下拉整列都是选不了的模型。
   */
  const load = useCallback((): void => {
    void api.titleModel().then(({ model, choices }) => {
      setCurrent(model)
      setModels(choices)
      setLoaded(true)
    })
  }, [api])

  useEffect(() => {
    load()
  }, [load])

  if (!loaded) return <SettingsGroup title="对话标题">{null}</SettingsGroup>

  const data = [
    { value: FOLLOW_CHAT, label: '跟随对话模型（默认）' },
    ...models.map((m) => ({ value: `${m.ref.provider}/${m.ref.id}`, label: m.label })),
  ]
  const value = current === null ? FOLLOW_CHAT : `${current.provider}/${current.id}`

  return (
    <SettingsGroup title="对话标题">
      <SettingRow description="生成对话标题用哪个模型；不设置就用这条对话自己的模型" label="生成标题的模型">
        <Select
          align="end"
          className="settings-select-trigger"
          data={data}
          onValueChange={(v) => {
            const next =
              v === FOLLOW_CHAT ? null : (models.find((m) => `${m.ref.provider}/${m.ref.id}` === v)?.ref ?? null)
            setCurrent(next)
            void api.setTitleModel(next)
          }}
          type="生成标题的模型"
          value={value}
        />
      </SettingRow>
    </SettingsGroup>
  )
}
