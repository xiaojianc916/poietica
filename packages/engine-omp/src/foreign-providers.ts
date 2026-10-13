import { readSetting, type SettingsScope } from './settings-access'

/*
 * 会读到隔离根以外内容的 provider。omp 18.5.0 的 discovery 提供者逐个核对后得出，保留的 6 个是
 * native / omp-plugins / mcp-json / ssh-json / skillshare / agents（`agents` 按产品决定放行）。
 */
export const FOREIGN_PROVIDERS: readonly string[] = Object.freeze([
  'claude',
  'claude-plugins',
  'codex',
  'gemini',
  'opencode',
  'cursor',
  'windsurf',
  'cline',
  'github',
  'vscode',
  'agents-md',
  'claude-md',
  'agent-plugins',
])

/*
 * 曾经在 FOREIGN_PROVIDERS 里、现在放行的 id。老用户的 `config.yml` 里已经被旧版本写进 `disabledProviders`
 * （真机就是这一格），只改常量等于没改：启动时逐个 `enableProvider` 清掉、flush 一次。没写过就不写盘。
 */
export const RELEASED_PROVIDERS: readonly string[] = Object.freeze(['agents'])

const DISABLED_KEY = 'disabledProviders'

/*
 * 禁用全部外来 provider（omp 知识 #10）：写全局层并 flush，**不用**运行时覆盖层 —— 覆盖层是整表替换，
 * 会把此刻的列表钉死，用户以后在设置页启停 provider 都会被盖住。返回本次新禁用的 id；幂等。
 */
export async function disableForeignProviders(
  scope: SettingsScope,
  flush: () => Promise<void>,
  disableProvider: (providerId: string) => void,
): Promise<readonly string[]> {
  const current = readSetting(scope, DISABLED_KEY)
  const disabled = new Set(Array.isArray(current) ? (current as string[]) : [])
  const added = FOREIGN_PROVIDERS.filter((id) => !disabled.has(id))
  if (added.length === 0) return Object.freeze([])
  for (const id of added) disableProvider(id)
  await flush()
  return Object.freeze(added)
}

/* 放行迁移：把旧版本替用户写下的禁用项撤掉，形制同 disableForeignProviders。直接抹设置值会绕过 capability 注册表的内存集合，两个事实会当场分叉。幂等 */
export async function releaseForeignProviders(
  scope: SettingsScope,
  flush: () => Promise<void>,
  enableProvider: (providerId: string) => void,
): Promise<readonly string[]> {
  const current = readSetting(scope, DISABLED_KEY)
  const disabled = new Set(Array.isArray(current) ? (current as string[]) : [])
  const released = RELEASED_PROVIDERS.filter((id) => disabled.has(id))
  if (released.length === 0) return Object.freeze([])
  for (const id of released) enableProvider(id)
  await flush()
  return Object.freeze(released)
}
