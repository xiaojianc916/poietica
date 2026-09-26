import { commands } from '@poietica/contract'
import type { AgentSettingEntryWire } from '@poietica/contract/settings'
import { type AgentSettingsPort, catalogOf, entryOf } from '@poietica/settings'
import { throughIpc } from '../ipc-error'

/*
 * agent 设置目录在桌面端的传输口。
 *
 * 端口类型是 @poietica/settings 的领域形状（可缺席格是 undefined），线上类型是生成绑定
 * （可缺席格是 null）。两种形状说的是同一件事，差别只在「缺席怎么写」，所以翻译只有 null
 * 与 undefined 的对齐，没有第二张字段表。
 *
 * 值那一格原样搬运：`secret` 为真的格子读到的是 null，那是契约 —— agent 的值出了它的
 * 进程就不再是我们的盘（AGENTS.md §1）。这一层不往回填，也没有第二份值可填。
 */
export function createAgentSettingsPort(): AgentSettingsPort {
  return {
    read: () => throughIpc(() => commands.agentSettingsCatalog()).then(catalogOf),

    write: (path, value) =>
      throughIpc(() =>
        commands.agentSetSetting({
          path,
          /* 生成绑定要它自己的 JsonValue；领域侧是 unknown，交叉点只有这一次收窄。 */
          value: value as AgentSettingEntryWire['value'],
        }),
      ).then((settings) => settings.map(entryOf)),

    /*
     * 开文件这件事只把路径交给系统：路径由 Rust 现问 agent，前端不参与（那是安全边界，
     * 同 windowOpenExternalUrl 那条纪律，`window/commands.rs`）。所以这一层没有入参，
     * 也不把 Rust 的 `null` 交给上头 —— 命令成功就是成功，没有值。
     */
    openConfigFile: async () => {
      await throughIpc(() => commands.agentOpenConfigFile())
    },
  }
}
