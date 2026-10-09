import type { ModelSeries } from './usage-activity'

/*
 * 账上记的是 provider/id（与选择器那一格的取值同拼法），屏幕上要写的是模型名。
 *
 * 名字的产地只有一个：agent 自己的模型目录（ADR 0017）。这里不做第二份映射 ——
 * 目录里找不到就退回别名，屏幕显示一个我们不认识的名字比显示 provider/id 更糟。
 *
 * **迁移自** legacy \`packages/settings/src/ui/model-labels.ts\`，只换数据来路：
 * legacy 的 \`ModelCatalogData\` 是 \`{ provider, model, displayName }\`，新架构里目录由
 * models 契约的 \`ModelInfo\` 折出来（\`{ provider, id, name }\`）—— 字段名不同、语义逐条对应，
 * 所以由调用方（组合根）折成这张表交进来，这个函数只做「按 provider/id 查名字」这一件事。
 */

/** provider/id → 显示名。查不到就退回账上的别名。 */
export type ModelNames = ReadonlyMap<string, string>

export function labelModels(series: readonly ModelSeries[], names: ModelNames): readonly ModelSeries[] {
  if (names.size === 0 || series.length === 0) {
    return series
  }

  return series.map((line) => ({ ...line, label: names.get(line.model) ?? line.model }))
}
