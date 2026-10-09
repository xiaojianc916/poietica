import type { ConversationUi } from '@poietica/feature-conversation/ui-api'
import type { DialogService } from '@poietica/ui-kernel'
import type { UpdateApi } from './api'

/**
 * 「重启并安装」的唯一入口（横幅与帮助菜单里的检查行共用）。
 *
 * 重启会掐断运行中的对话，这个代价必须先由人确认 —— 两条路谁也不许绕过这一步。
 * 没有对话在跑时直接装：没有可失去的东西就不多问一句。
 */
export function installUpdate(d: { api: UpdateApi; conversation: ConversationUi; dialogs: DialogService }): void {
  const running = d.conversation.runningCount()
  if (running === 0) {
    void d.api.install()
    return
  }
  void d.dialogs
    .confirm({
      title: '重启并安装',
      body: `有 ${String(running)} 个对话正在运行，重启将中断它们`,
      confirmLabel: '重启并安装',
      danger: true,
    })
    .then((ok) => {
      if (ok) void d.api.install()
    })
}
