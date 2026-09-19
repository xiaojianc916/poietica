/** 三个动作的输入与输出形状；消费者只有 app-update-store。 */
export type UpdateProgress = { percent: number | null }
export type UpdateRelease = { version: string; notes: string | null }

export interface AppUpdateController {
  readonly check: () => Promise<UpdateRelease | null>
  readonly download: (
    version: string,
    onProgress: (progress: UpdateProgress) => void,
  ) => Promise<void>
  readonly relaunch: () => Promise<void>
  readonly dispose: () => Promise<void>
}
