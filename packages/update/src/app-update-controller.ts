import type { UpdateProgress, UpdateRelease } from './model'

export type { UpdateProgress, UpdateRelease }

export interface AppUpdateController {
  readonly check: () => Promise<UpdateRelease | null>
  readonly download: (
    version: string,
    onProgress: (progress: UpdateProgress) => void,
  ) => Promise<void>
  readonly relaunch: () => Promise<void>
  readonly dispose: () => Promise<void>
}
