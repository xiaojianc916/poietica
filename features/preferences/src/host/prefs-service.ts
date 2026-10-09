import type { Logger } from '@poietica/foundation'
import type { JsonDocument } from '@poietica/fs-kit'
import { type Preferences, type PreferencesPatch, Preferences as PreferencesSchema } from '../contract/entities'

export interface PrefsService {
  load(): Promise<Preferences>
  get(): Preferences
  update(patch: PreferencesPatch): Promise<Preferences>
}

/**
 * patch 合并：分组内做字段级合并，顶层字段只在 patch 里出现过才覆盖。
 * 结果再经 Preferences.parse —— 默认值、枚举约束都在那一步兜底。
 */
export function mergePatch(cur: Preferences, p: PreferencesPatch): Preferences {
  return PreferencesSchema.parse({
    ...cur,
    ...(p.theme === undefined ? {} : { theme: p.theme }),
    ...(p.language === undefined ? {} : { language: p.language }),
    ...(p.logLevel === undefined ? {} : { logLevel: p.logLevel }),
    general: { ...cur.general, ...p.general },
    appearance: { ...cur.appearance, ...p.appearance },
    modelPicker: { ...cur.modelPicker, ...p.modelPicker },
    updates: { ...cur.updates, ...p.updates },
  })
}

export function createPrefsService(d: {
  doc: JsonDocument<Preferences>
  /** 主题、日志级别；prev 为 null 表示启动时 */
  applyEffects(prev: Preferences | null, next: Preferences): void
  emitChanged(p: Preferences): void
  logger?: Logger
}): PrefsService {
  const update = async (patch: PreferencesPatch): Promise<Preferences> => {
    const prev = d.doc.current()
    const next = mergePatch(prev, patch)
    // 顺序固定：合并 → 校验 → save（立即写，偏好必须可靠）→ 广播 → 执行副作用。
    // 写盘失败时不广播，并把错误返回给 UI。
    await d.doc.save(next)
    d.emitChanged(next)
    d.applyEffects(prev, next)
    return next
  }
  return {
    load: () => d.doc.load(),
    get: () => d.doc.current(),
    update,
  }
}
