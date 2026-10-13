import type { ModelSeries } from './usage-activity'

/* 账上记的是 provider/id，屏幕上要写模型名。名字的产地只有一个：agent 自己的模型目录（ADR 0017）。这里不做第二份映射 —— 目录里找不到
 * 就退回别名，屏幕显示一个我们不认识的名字比显示 provider/id 更糟。调用方（组合根）把目录折成这张表交进来，本函数只做「按 provider/id
 * 查名字」这一件事。 */
/** provider/id → 显示名。查不到就退回账上的别名。 */
export type ModelNames = ReadonlyMap<string, string>

export function labelModels(series: readonly ModelSeries[], names: ModelNames): readonly ModelSeries[] {
  if (names.size === 0 || series.length === 0) {
    return series
  }

  return series.map((line) => ({ ...line, label: names.get(line.model) ?? line.model }))
}
