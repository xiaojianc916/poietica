import {
  commands,
  events,
  type UpdateProgress,
  type UpdateRelease,
} from '@poietica/ipc/generated/ipc-bindings'

export interface AppUpdateController {
  /** 有没有比当前版本更新的发布。没有则为 null。 */
  readonly check: () => Promise<UpdateRelease | null>
  /** 把指定版本下下来，不安装。进度在下载期间回调，函数在下完时兑现。 */
  readonly download: (
    version: string,
    onProgress: (progress: UpdateProgress) => void,
  ) => Promise<void>
  /** 安装已下好的那一个并重启。正常路径上进程会在兑现之前就被接管。 */
  readonly relaunch: () => Promise<void>
}

/**
 * 更新的三步。
 *
 * 下载与安装刻意是两条命令：下完只是把校验过的可执行文件放在旁边，换装与重启由
 * 人按下那一刻决定，不在进度条跑满的同一刻夺走进程。
 *
 * 进度走生成的事件面：事件名与 payload 类型都从 Rust 一次生成，改名即编译失败。
 *
 * 版本随下载请求一起过去：由渲染层指定要哪一个，原生侧不再自己决定"最新"。
 */
export function createAppUpdateController(): AppUpdateController {
  return {
    check() {
      return commands.updateCheck()
    },

    async download(version, onProgress) {
      const stopListening = await events.updateProgress.listen((event) => {
        onProgress(event.payload)
      })

      try {
        await commands.updateDownload(version)
      } finally {
        stopListening()
      }
    },

    async relaunch() {
      /*
       * 命令的成功值在 Rust 那边是 ()，导出到 TypeScript 就是 null。这个 null
       * 不是契约的一部分，只是"没有返回值"的一种编码，所以在边界上吞掉，不让
       * 它渗进 AppUpdateController。
       */
      await commands.updateRelaunch()
    },
  }
}
