import type { AgentSettingEntryWire, AgentSettingsCatalogWire } from '@poietica/contract/settings'

/*
 * agent 自己那份设置目录的领域形状。
 *
 * 线上型别（生成的绑定）与这里说的是同一件事，差别只在「可缺席怎么写」：线上一律 null，
 * 这里一律 undefined。正文一格都不抄 —— label / description / 选项表 / 默认值全是
 * agent 自报的，我们只负责画（ADR 0018 决定四）。
 */
export interface AgentSettingOption {
  readonly value: string
  readonly label: string
  readonly description?: string
}

/**
 * 归产品哪一个**剥离页**画。
 *
 * `memory` 与 `persona`（人设与风格）本来混在 agent 自己的栏目里，产品各拆成一页；
 * 主页面不再画这两类行。判据在桥侧（packages/agent-bridge/src/settings-labels.ts）。
 */
export type AgentSettingSection = 'memory' | 'persona'

export interface AgentSettingEntry {
  readonly path: string
  /** agent 自己那份 schema 的类型词：boolean / enum / number / string / array / record。 */
  readonly type: string
  readonly label: string
  readonly description: string
  readonly tab: string
  /** 分节的**键**（agent 自己的词）。分组认它，不译：译了同一节会分裂成两节。 */
  readonly group?: string
  /** 分节给人看的那一列；缺席就用 `group` 那个键。 */
  readonly groupLabel?: string
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
   * 桥刻意不搬求值器（ADR 0018 决定四）。界面这一侧能诚实地算出来的只有它自己那几条，
   * 其余一律按「不知道就不显示」处理，见 ui/agent-settings/settings-conditions.ts。
   */
  readonly condition?: string
  /**
   * 这一格的**行**由产品别处的控件负责。
   *
   * 输入框那一排已有选择器的（计划/目标/思考档位/审批）、设置页已有专属一节的（浏览器），
   * 不再在 agent 设置里画第二遍 —— 一个事实两个控件是缺陷（AGENTS.md §1）。
   * 值仍在，因为别的格子按 `condition` 读它决定显不显示；界面只跳过这一行。
   */
  readonly owned?: boolean
  /**
   * 归产品哪一个剥离页画；缺席即不属于任何一页（绝大多数格子都是这一档）。
   *
   * 与 `owned` 正交：`owned` 说的是「这一行别处已经有控件」，这里说的是「这一行归哪一页」。
   * 一格可以既有归属又 owned（`defaultThinkingLevel`），那一页也不画它的行。
   */
  readonly section?: AgentSettingSection
}

export interface AgentSettingsCatalog {
  /**
   * 栏目清单，按 agent 自己的顺序。
   *
   * 键与名成对给：键是 agent 的栏目词汇（筛选认它），名是给人看的那一列。两条并行数组
   * 一旦错位就是「点了外观出来模型」，而这里没有一种读法能发现它错了。
   */
  readonly tabs: readonly AgentSettingTab[]
  readonly settings: readonly AgentSettingEntry[]
  /**
   * agent 此刻在用的那份配置文件。
   *
   * 这是「几百项设置」这件事的出路：不必都画成控件，直接改它自己的文件更省事。
   * 路径由 agent 自己报（正本 omp 的 getAgentDir），这一侧不拼 —— 拼一份换个 home 就分叉。
   */
  readonly configFile: string
  /** 那份文件此刻在不在；不在就是还没写过。 */
  readonly configFileExists: boolean
}

export interface AgentSettingTab {
  readonly key: string
  readonly label: string
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
  /**
   * 把 agent 自己的配置文件交给系统默认编辑器。
   *
   * 改完不必我们替它重读：omp 自己看盘（`Settings.reloadFromDisk()`），下一次读目录
   * 就读到新的。这一侧只负责把文件交出去 —— 那是它写过的盘，不是我们的。
   */
  readonly openConfigFile: () => Promise<void>
}

/** 线上形状 → 领域形状。null 与 undefined 的对齐，没有第二张字段表。 */
export function catalogOf(wire: AgentSettingsCatalogWire): AgentSettingsCatalog {
  return {
    tabs: wire.tabs,
    settings: wire.settings.map(entryOf),
    configFile: wire.configFile,
    configFileExists: wire.configFileExists,
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
    ...(wire.groupLabel === null ? {} : { groupLabel: wire.groupLabel }),
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
    ...(wire.owned ? { owned: true } : {}),
    /*
     * 显式认那两个词，不写成 `wire.section === null ? {} : …`：线上是 `string | null`，
     * 只挡 null 会让一个生字符串直接冒充已知识别。上游将来加第三个取值时，这一格
     * **静默不画它的行**（降级方向与 settings-conditions 的「认不出就不显示」一致），
     * 而不是把一格我们没定义归属的设置画到主页面上。
     */
    ...(wire.section === 'memory' || wire.section === 'persona' ? { section: wire.section } : {}),
  }
}
