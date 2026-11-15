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
export const CHECKPOINT_STEP_LABEL = '步骤结束'

/** 检查点里一个文件的增删行数；binary 的增删是 0。 */
export interface CheckpointNumstat {
  readonly path: string
  readonly added: number
  readonly removed: number
}

export interface CheckpointReadFileParams {
  readonly workspaceRoot: string
  readonly checkpoint: string
  /** 工作区内的相对路径（正斜杠）。 */
  readonly path: string
}

export interface CheckpointService {
  create(input: CheckpointCreateParams): Promise<Checkpoint>
  list(workspaceRoot: string, limit?: number): Promise<Checkpoint[]>
  diff(input: CheckpointDiffParams): Promise<string>
  /** 两个检查点之间真正变过的路径（相对工作区根、正斜杠）。 */
  diffPaths(input: CheckpointDiffParams): Promise<string[]>
  /** 两个检查点之间每个文件的行数变化；用于检查点优先的审查列表。 */
  diffNumstat(input: CheckpointDiffParams): Promise<CheckpointNumstat[]>
  /** 工作树相对某个检查点变过的路径；包含未跟踪的新文件。 */
  changedPaths(input: CheckpointChangedPathsParams): Promise<string[]>
  /** 读检查点里的文件正文；不存在返回 null（二进制可能读成乱码，调用方按文本用）。 */
  readFile(input: CheckpointReadFileParams): Promise<string | null>
  restore(input: CheckpointRestoreParams): Promise<CheckpointRestoreResult>
}

export const CheckpointServiceToken = defineServiceToken<CheckpointService>('checkpoints', 'CheckpointService')
