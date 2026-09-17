/* 由组合根注入命令注册表的快照，避免 settings 依赖 workspace。 */
export interface KeybindingEntry {
  readonly id: string
  readonly label: string
  readonly description?: string | undefined
  /* 已按当前平台格式化；空数组表示未分配。 */
  readonly shortcuts: readonly string[]
}

export interface KeybindingCatalog {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => readonly KeybindingEntry[]
}
