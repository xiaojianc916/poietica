import { commands } from '@poietica/contract'
import type { SettingsStore } from '@poietica/settings'

/*
 * 设置在桌面端的存储。
 *
 * 边界上没有翻译：生成物与领域类型同名、同形、同为 camelCase，所以这一层只是把
 * 三条命令接上端口。此前那处唯一的翻译是为 Rust 的 HashMap 服务的 —— 那张只写
 * 不读的 shortcuts 表已经删掉，翻译跟着它一起走，而不是留一个逐字段抄写的壳。
 *
 * 契约由 bun run ipc:generate 从 Rust 单向生成：两侧对不上是 typecheck 阶段的错误，
 * 不是运行期的惊喜。
 */
export function createDesktopSettingsStore(): SettingsStore {
  return {
    load() {
      return commands.settingsGet()
    },

    async save(settings) {
      await commands.settingsSet(settings)
    },

    reset() {
      return commands.settingsReset()
    },
  }
}
