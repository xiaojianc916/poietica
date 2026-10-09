import type { ModelRef } from '@poietica/engine'
import type { Logger } from '@poietica/foundation'
import type { OmpModelRegistry, OmpModel as OmpModelShape } from '../omp-context'

/** omp 的 enabledModels：可用模型白名单（config/model-settings.ts 的 cfgEnabledModels）。 */
export const ENABLED_MODELS_PATH = 'enabledModels'

/** registry 那一侧 ModelsPort 用得着的操作（都是 omp ModelRegistry 的真实成员）。 */
export interface RegistryPort {
  all(): readonly OmpModelLike[]
  available(): readonly OmpModelLike[]
  find(provider: string, modelId: string): OmpModelLike | undefined
  hasConfiguredAuth(model: OmpModelLike): boolean
  hydrateCredentialScopedModelCaches(): Promise<void>
  refreshInBackground(): void
}

/** omp 的一条模型里我们读的那几格（`model-helpers` 与 `models.ts` 共用的形状）。 */
export type OmpModelLike = OmpModelShape

/** omp 的 ModelRegistry 实例 → RegistryPort。 */
export function registryPortOf(registry: OmpModelRegistry): RegistryPort {
  return {
    all: () => registry.getAll(),
    available: () => registry.getAvailable(),
    find: (provider, modelId) => registry.find(provider, modelId),
    hasConfiguredAuth: (model) => registry.hasConfiguredAuth(model as never),
    hydrateCredentialScopedModelCaches: () => registry.hydrateCredentialScopedModelCaches(),
    refreshInBackground: () => registry.refreshInBackground(),
  }
}

/*
 * omp 18.5.0 的 ModelRegistry：getAll() / getAvailable() / hasConfiguredAuth(model) /
 * find(provider, modelId) —— 没有 find(selector) 的一参形态，也没有 hasAuth 的旧名（18.3.0 把它
 * 拆进了 credentials / keys 两组子 API）。端口把这几件收成 RegistryPort，省得每个调用点各记一遍。
 */

/** 模型在界面上的名字：provider/id（与 omp 选择器同一拼法）。 */
export function aliasOf(model: { readonly provider: string; readonly id: string }): string {
  return `${model.provider}/${model.id}`
}

/** omp 的 enabledModels 数组 → 启用判据。空表 = 全放行（omp 的语义：没配就是不过滤）。 */
export function enabledMatcher(patterns: readonly string[]): (ref: ModelRef) => boolean {
  if (patterns.length === 0) return () => true
  const exact = new Set<string>()
  const globs: RegExp[] = []
  for (const pattern of patterns) {
    if (pattern.includes('*') || pattern.includes('?')) globs.push(globOf(pattern))
    else exact.add(pattern)
  }
  return (ref) => {
    const alias = aliasOf(ref)
    if (exact.has(alias) || exact.has(ref.id)) return true
    return globs.some((glob) => glob.test(alias))
  }
}

function globOf(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.split('*').join('.*').split('?').join('.')
  return new RegExp(`^${body}$`)
}

/** 读 omp 的设置并取出字符串数组（读不出来就是空表）。 */
export function stringArrayOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/**
 * 算下一次写入 enabledModels 的整份数组。
 *
 * 空表在 omp 里是「不过滤」（resolveAllowedModels：patterns 为空直接交回 available）；
 * 所以第一次「停用一条」不能只从空表里删 —— 那什么都不变。此时把**此刻可用的整份清单**
 * 写进白名单再摘掉这一条，白名单的含义才从「没配」变成「除了它都要」。
 */
export function nextEnabledPatterns(
  patterns: readonly string[],
  available: readonly string[],
  ref: ModelRef,
  enabled: boolean,
): readonly string[] {
  const alias = aliasOf(ref)
  if (enabled) {
    if (patterns.length === 0 || patterns.includes(alias)) return patterns
    return [...patterns, alias]
  }
  const base = patterns.length === 0 ? available.filter((item) => item !== alias) : patterns
  return base.filter((item) => item !== alias)
}

/** 端口里的异常都经 toEngineError；这里只留一条 warn 痕（key 之类的敏感值绝不进 data）。 */
export function warnOnce(logger: Logger, message: string, data?: Record<string, unknown>): void {
  logger.warn(message, data)
}
