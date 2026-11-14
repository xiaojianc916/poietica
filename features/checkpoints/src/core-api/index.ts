import { defineServiceToken } from '@poietica/foundation'
import type {
  Checkpoint,
  CheckpointChangedPathsParams,
  CheckpointCreateParams,
  CheckpointDiffParams,
  CheckpointRestoreParams,
  CheckpointRestoreResult,
} from '../contract/entities'

/** 轮次边界检查点的标签；撤销按这两个标签找一轮的起止。 */
export const CHECKPOINT_TURN_START_LABEL = '轮次开始'
export const CHECKPOINT_TURN_END_LABEL = '轮次结束'

export interface CheckpointService {
  create(input: CheckpointCreateParams): Promise<Checkpoint>
  list(workspaceRoot: string, limit?: number): Promise<Checkpoint[]>
  diff(input: CheckpointDiffParams): Promise<string>
  /** 两个检查点之间真正变过的路径（相对工作区根、正斜杠）。 */
  diffPaths(input: CheckpointDiffParams): Promise<string[]>
  /** 工作树相对某个检查点变过的路径；包含未跟踪的新文件。 */
  changedPaths(input: CheckpointChangedPathsParams): Promise<string[]>
  restore(input: CheckpointRestoreParams): Promise<CheckpointRestoreResult>
}

export const CheckpointServiceToken = defineServiceToken<CheckpointService>('checkpoints', 'CheckpointService')
