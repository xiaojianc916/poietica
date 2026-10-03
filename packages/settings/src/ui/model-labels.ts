import type { ModelCatalogData } from '../model-catalog/model'
import type { ModelSeries } from './usage-activity'

/*
 * 账上记的是 provider/id（与选择器那一格的取值同拼法），屏幕上要写的是模型名。
 *
 * 名字的产地只有一个：agent 自己的模型目录（ADR 0017）。这里不做第二份映射 ——
 * 目录里找不到就退回别名，屏幕显示一个我们不认识的名字比显示 provider/id 更糟。
 */
export function labelModels(
  series: readonly ModelSeries[],
  catalog: ModelCatalogData | null,
): readonly ModelSeries[] {
  if (catalog === null || series.length === 0) {
    return series
  }

  const names = new Map(
    catalog.models.map((model) => [
      `${model.provider}/${model.model}`,
      model.displayName ?? model.model,
    ]),
  )

  return series.map((line) => ({ ...line, label: names.get(line.model) ?? line.model }))
}
