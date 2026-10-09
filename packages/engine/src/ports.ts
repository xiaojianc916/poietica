import type { Event } from '@poietica/foundation'
import type { z } from 'zod'
import type {
  Capabilities,
  MarketplaceEntry,
  McpServerInfo,
  McpStatus,
  ModelInfo,
  ModelRef,
  PluginInfo,
  ProviderInfo,
  SettingDescriptor,
  SkillInfo,
} from './values'

export interface SessionFilesPort {
  exists(sessionFile: string): Promise<boolean>
  fork(sessionFile: string, undoTurns: number): Promise<{ sessionId: string; sessionFile: string }>
  delete(sessionFile: string): Promise<void>
  exportHtml(sessionFile: string, outFile: string): Promise<void>
  exportMarkdown(sessionFile: string): Promise<string>
}
export interface ModelsPort {
  providers(): Promise<z.infer<typeof ProviderInfo>[]>
  models(): Promise<z.infer<typeof ModelInfo>[]>
  setApiKey(provider: string, key: string): Promise<void> // key 永不回传
  clearApiKey(provider: string): Promise<void>
  setModelEnabled(ref: ModelRef, enabled: boolean): Promise<void>
  defaultModel(): Promise<ModelRef | null>
  setDefaultModel(ref: ModelRef): Promise<void>
  defaultThinking(): Promise<string | null>
  setDefaultThinking(level: string | null): Promise<void>
  upsertCustomProvider(def: CustomProviderDef): Promise<void>
  removeCustomProvider(id: string): Promise<void>
  readonly onDidChange: Event<void>
}
export interface CustomProviderDef {
  readonly id: string
  readonly name: string
  readonly api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  readonly baseUrl: string
  readonly models: readonly {
    id: string
    name: string
    contextWindow: number | null
    reasoning: boolean
    vision: boolean
  }[]
}
export interface SettingsPort {
  catalog(): Promise<z.infer<typeof SettingDescriptor>[]>
  /**
   * 设置页上分节的次序（07 页 §7B/§7C：分组顺序取自 engine-omp 设置目录）。
   *
   * 它是 **`group` 键**的序列（`Prompt` / `Mnemopi`…），与 descriptor 的 `group` 字段同源 ——
   * 界面按那个键归并，换成译名会让两条不同的键撞上同一个名字。
   *
   * 放在端口而不是让 agent-settings 直接读 engine-omp：depcruise 的 `engine-omp-only-in-app`
   * 禁止功能依赖 engine-omp，顺序只能经引擎端口过来。
   */
  readonly groupOrder: readonly string[]
  set(path: string, value: unknown): Promise<void>
  reset(path: string): Promise<void>
  capabilities(): Promise<z.infer<typeof Capabilities>>
  setCapability(name: keyof z.infer<typeof Capabilities>, enabled: boolean): Promise<void>
  /** 当前设置的 Python 解释器路径；没设置（自动探测）时为 null（07 页 §13C 的 onReady 判据） */
  getPythonInterpreter(): Promise<string | null>
  setPythonInterpreter(exePath: string | null): Promise<void>
  readonly onDidChange: Event<{ readonly paths: readonly string[] }>
}
export interface SkillsPort {
  list(cwd: string | null): Promise<z.infer<typeof SkillInfo>[]>
  setEnabled(id: string, enabled: boolean): Promise<void>
  installFromDirectory(dir: string): Promise<z.infer<typeof SkillInfo>>
  installFromZip(zipFile: string): Promise<z.infer<typeof SkillInfo>>
  /** 只清理 omp 设置里该技能的启用状态；技能目录由 extensions 经 Host 的 shell.trashItem 移到回收站 */
  forget(id: string): Promise<void>
  read(id: string): Promise<{ markdown: string }>
}
export interface McpPort {
  list(): Promise<z.infer<typeof McpServerInfo>[]>
  upsert(server: z.infer<typeof McpServerInfo>): Promise<void>
  remove(name: string): Promise<void>
  status(): Promise<z.infer<typeof McpStatus>[]>
  readonly onDidChangeStatus: Event<z.infer<typeof McpStatus>[]>
}
export interface PluginsPort {
  list(): Promise<z.infer<typeof PluginInfo>[]>
  marketplace(query: string | null): Promise<z.infer<typeof MarketplaceEntry>[]>
  install(id: string): Promise<z.infer<typeof PluginInfo>>
  uninstall(id: string): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
}
