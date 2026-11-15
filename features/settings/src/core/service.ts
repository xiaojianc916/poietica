import type { Clock } from '@poietica/foundation'
import { AppError } from '@poietica/foundation'
import type { ModuleDatabase } from '@poietica/storage-sqlite'
import type { SettingContext, SettingDefinition, SettingScope, SettingView } from '../contract/entities'
import { settingsErrors } from '../contract/errors'
import type { SettingsProvider, SettingsService, SettingWrite } from '../core-api'

interface ValueRow {
  readonly value: string
}

export interface CreateSettingsServiceOptions {
  readonly db: ModuleDatabase
  readonly clock: Clock
}

/** 统一设置注册表（ADR-012 / §17）：定义在内存，值落模块表；读取按 thread > project > global > default。 */
export function createSettingsService(o: CreateSettingsServiceOptions): SettingsService {
  const definitions = new Map<string, SettingDefinition>()
  const providers = new Map<string, SettingsProvider>()
  const select = o.db.prepare<ValueRow>(
    'SELECT value FROM settings_values WHERE scope = ? AND scope_id = ? AND key = ?',
  )
  const upsert = o.db.prepare(
    `INSERT INTO settings_values (scope, scope_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (scope, scope_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  )

  const definitionOf = (key: string): SettingDefinition => {
    const definition = definitions.get(key)
    if (definition === undefined) throw new AppError(settingsErrors.unknown_key, `设置项没有注册：${key}`)
    return definition
  }

  const read = (scope: SettingScope, scopeId: string, key: string): unknown => {
    const row = select.get(scope, scopeId, key)
    if (row === undefined || row === null) return undefined
    return JSON.parse(row.value) as unknown
  }

  const resolve = (definition: SettingDefinition, context: SettingContext = {}): SettingView => {
    const candidates: readonly (readonly [SettingScope, string | undefined])[] = [
      ['thread', context.threadId],
      ['project', context.workspaceId],
      ['global', 'global'],
    ]
    for (const [scope, scopeId] of candidates) {
      if (scopeId === undefined || scopeId === '' || !definition.scopes.includes(scope)) continue
      const value = read(scope, scopeId, definition.key)
      if (value !== undefined) return viewOf(definition, value, scope)
    }
    return viewOf(definition, definition.defaultValue, 'default')
  }

  const viewOf = (definition: SettingDefinition, value: unknown, source: SettingView['source']): SettingView => ({
    definition,
    value: definition.sensitive === true ? null : value,
    source,
    configured: source !== 'default',
  })

  const setLocal = (input: SettingWrite): void => {
    const definition = definitionOf(input.key)
    if (!definition.scopes.includes(input.scope)) {
      throw new AppError(settingsErrors.invalid_scope, `${input.key} 不支持 ${input.scope} 作用域`)
    }
    validate(definition, input.value)
    upsert.run(input.scope, input.scopeId, input.key, JSON.stringify(input.value), o.clock.now())
  }

  return {
    register(definition) {
      if (definitions.has(definition.key)) {
        throw new AppError(settingsErrors.duplicate_key, `设置项重复注册：${definition.key}`)
      }
      definitions.set(definition.key, definition)
    },
    registerProvider(provider) {
      if (providers.has(provider.id)) {
        throw new AppError(settingsErrors.duplicate_key, `设置后端重复注册：${provider.id}`)
      }
      providers.set(provider.id, provider)
    },
    get(key, context) {
      return resolve(definitionOf(key), context)
    },
    set: setLocal,
    async write(input) {
      const provider = [...providers.values()].find((candidate) => candidate.owns(input.key))
      if (provider?.set !== undefined) {
        await provider.set(input)
        return
      }
      setLocal(input)
    },
    describe(context) {
      return [...definitions.values()].sort((a, b) => a.key.localeCompare(b.key)).map((d) => resolve(d, context))
    },
    async describeAll(context) {
      const local = [...definitions.values()].sort((a, b) => a.key.localeCompare(b.key)).map((d) => resolve(d, context))
      const external = await Promise.all([...providers.values()].map((provider) => provider.describe(context)))
      const seen = new Set(local.map((view) => view.definition.key))
      return [
        ...local,
        ...external.flat().filter((view) => {
          if (seen.has(view.definition.key)) return false
          seen.add(view.definition.key)
          return true
        }),
      ]
    },
  }
}

function validate(definition: SettingDefinition, value: unknown): void {
  const ok =
    definition.type === 'boolean'
      ? typeof value === 'boolean'
      : definition.type === 'string'
        ? typeof value === 'string'
        : definition.type === 'number'
          ? typeof value === 'number' && Number.isFinite(value)
          : definition.type === 'select'
            ? (definition.options ?? []).some((option) => option.value === value)
            : true
  if (!ok) throw new AppError(settingsErrors.invalid_value, `${definition.key} 的值类型不对`)
}
