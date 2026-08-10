/*
 * 设置页要读的那份快捷键事实的形状。
 *
 * 真相在命令注册表里，而这个包不认识 workspace —— tools/architecture 里
 * settings ✗→ workspace 是显式禁止的一条。所以这里只定义形状，实现由组合根
 * 注入，与 appVersion / dataDirectory 同一条纪律。
 *
 * keys 是已按当前平台渲染好的片段（['Ctrl', 'K']），不是逻辑串：平台差异属于
 * 显示，而显示只有 packages/workspace 那一份实现。
 */
export interface KeybindingEntry {
  readonly id: string
  readonly label: string
  readonly category: string
  readonly keys: readonly string[]
}

export interface KeybindingCatalog {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => readonly KeybindingEntry[]
}
