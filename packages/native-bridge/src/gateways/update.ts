import { commands, events } from '@poietica/contract'
import type { AppUpdateController } from '@poietica/update'
import { throughIpc } from '../error'

/*
 * 更新三步的 IPC 实现：实现 @poietica/update 的 AppUpdateController 端口，由
 * 组合根注入 store。进度走生成的事件面：事件名与 payload 类型都从 Rust 一次生成，
 * 改名即编译失败。版本随下载请求一起过去：由渲染层指定要哪一个，原生侧不再自己
 * 决定「最新」。
 */

export const appUpdateController: AppUpdateController = {
  check: () => throughIpc(() => commands.updateCheck()),

  async download(version, onProgress) {
    const stopListening = await events.updateProgress.listen((event) => {
      onProgress(event.payload)
    })

    try {
      await throughIpc(() => commands.updateDownload(version))
    } finally {
      stopListening()
    }
  },

  async relaunch() {
    /*
     * 命令的成功值在 Rust 那边是 ()，导出到 TypeScript 就是 null。这个 null
     * 不是契约的一部分，只是「没有返回值」的一种编码，所以在边界上吞掉，不让
     * 它渗进端口。
     */
    await throughIpc(() => commands.updateRelaunch())
  },
}
