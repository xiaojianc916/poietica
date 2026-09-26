import type { AgentSettingEntryWire, AgentSettingsCatalogWire } from '@poietica/contract/settings'

/*
 * agent 自己那份设置目录的领域形状。
 *
 * 线上型别（生成的绑定）与这里说的是同一件事，差别只在「可缺席怎么写」：线上一律 null，
 * 这里一律 undefined。正文一格都不抄 —— label / description / 选项表 / 默认值全是
 * agent 自报的，我们只负责画（ADR 0054 决定四）。
 */
export interface AgentSettingOption {
  readonly value: string
  readonly label: string
  readonly description?: string
}

export interface AgentSettingEntry {
  readonly path: string
  /** agent 自己那份 schema 的类型词：boolean / enum / number / string / array / record。 */
  readonly type: string
  readonly label: string
  readonly description: string
  readonly tab: string
  readonly group?: string
  readonly default: unknown
  /**
   * 此刻生效的值。
   *
   * `secret` 为真时恒为 null：值出了 agent 的进程就不再是我们的盘。两层各自折一次
   * ——桥的 `entryOf` 与 crates 的 `SettingEntry::from_wire`——所以这里读到 null 是
   * 契约，不是「碰巧还没读到」。
   */
  readonly value: unknown
  /**
   * 这一格是不是钥匙。
   *
   * 判据是 agent 自己的 `isCredential()`，不是 `ui.secret` ——后者在 18.3.0 里
   * 一条都不为真（实测 0 条），拿它当判据会让三把钥匙显示成普通输入框。
   */
  readonly secret: boolean
  /** 钥匙配过没有；非钥匙恒为 false。界面只说「已配置 / 未配置」。 */
  readonly hasValue: boolean
  readonly options?: readonly AgentSettingOption[]
  readonly enumValues?: readonly string[]
  /** 风险提示：会把用户拉进限流或封号的那类设置，原样上屏。 */
  readonly warning?: string
  /**
   * 可见性条件的**名字**（如 `advisorEnabled`），不是判据。
   *
   * 桥刻意不搬求值器（ADR 0054 决定四）。界面这一侧能诚实地算出来的只有它自己那几条，
   * 其余一律按「不知道就不显示」处理，见 ui/agent-settings/conditions.ts。
   */
  readonly condition?: string
}

export interface AgentSettingsCatalog {
  /**
   * 栏目清单，按 agent 自己的顺序。
   *
   * 导航由它搭，不在我们这侧另写一份：手抄一份就是第二个事实，上游加一栏我们静默落后
   * （AGENTS.md §0）。
   */
  readonly tabs: readonly string[]
  readonly settings: readonly AgentSettingEntry[]
}

export interface AgentSettingsPort {
  readonly read: () => Promise<AgentSettingsCatalog>
  /**
   * 改一格设置。
   *
   * 交回的是**改完之后整份目录**：调用方拿它刷新自己，不做乐观改写 —— 改没改由 agent
   * 自己说，写的是它自己的盘。它自己热重载，没有重启这一步。
   */
  readonly write: (path: string, value: unknown) => Promise<readonly AgentSettingEntry[]>
}

/** 线上形状 → 领域形状。null 与 undefined 的对齐，没有第二张字段表。 */
export function catalogOf(wire: AgentSettingsCatalogWire): AgentSettingsCatalog {
  return {
    tabs: wire.tabs,
    settings: wire.settings.map(entryOf),
  }
}

export function entryOf(wire: AgentSettingEntryWire): AgentSettingEntry {
  return {
    path: wire.path,
    type: wire.type,
    label: wire.label,
    description: wire.description,
    tab: wire.tab,
    ...(wire.group === null ? {} : { group: wire.group }),
    default: wire.default,
    value: wire.value,
    secret: wire.secret,
    hasValue: wire.hasValue,
    ...(wire.options === null
      ? {}
      : {
          options: wire.options.map((option) => ({
            value: option.value,
            label: option.label,
            ...(option.description === null ? {} : { description: option.description }),
          })),
        }),
    ...(wire.enumValues === null ? {} : { enumValues: wire.enumValues }),
    ...(wire.warning === null ? {} : { warning: wire.warning }),
    ...(wire.condition === null ? {} : { condition: wire.condition }),
  }
}
