import type { UpdateProgress, UpdateRelease } from '@poietica/contract'

/*
 * 更新的三步端口：领域不认识 IPC，实现住在 @poietica/native-bridge 的
 * gateways/update.ts，由组合根注入 store。
 *
 * 下载与安装刻意是两条命令：下完只是把校验过的可执行文件放在旁边，换装与重启由
 * 人按下那一刻决定，不在进度条跑满的同一刻夺走进程。
 */

export type { UpdateProgress, UpdateRelease }

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
