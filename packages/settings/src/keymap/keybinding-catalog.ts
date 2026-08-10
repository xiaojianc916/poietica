/*
 * 设置页要读的那份快捷键事实的形状。
 *
 * 真相在命令注册表里，而这个包不认识 workspace —— tools/architecture 里
 * settings ✗→ workspace 是显式禁止的一条。所以这里只定义形状，实现由组合根
 * 注入，与 appVersion / dataDirectory 同一条纪律。
 *
 * shortcut 是已按当前平台渲染好的写法（'Ctrl+K'），不是逻辑串：平台差异属于
 * 显示，而显示只有 packages/workspace 的 formatKeybinding 一份实现 —— 命令面板
 * 用的也是它，两处不可能对同一条绑定给出两种写法。
 *
 * 没有 category：这一页用搜索定位，不用分组定位，多一个字段就多一处会分叉的
 * 事实。命令面板需要分组是因为它没有筛选之外的第二种导航方式。
 */
export interface KeybindingEntry {
  readonly id: string
  readonly label: string
  readonly shortcut: string
}

export interface KeybindingCatalog {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => readonly KeybindingEntry[]
}
