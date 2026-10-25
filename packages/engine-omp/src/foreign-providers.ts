import { readSetting, type SettingsScope } from './settings-access'

/*
 * 会读到隔离根以外内容的 provider。omp 的 discovery 提供者逐个核对后得出（每个文件一个 PROVIDER_ID），
 * 保留的 6 个是 native / omp-plugins / mcp-json / ssh-json / skillshare / agents（`agents` 按产品决定放行）。
 * 核对方法见 docs/omp-sdk-reference.md §L 与 refactor-log Q43。
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
