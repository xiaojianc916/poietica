import { defineServiceToken } from '@poietica/foundation'
import type {
  Checkpoint,
  CheckpointCreateParams,
  CheckpointDiffParams,
  CheckpointRestoreParams,
  CheckpointRestoreResult,
} from '../contract/entities'

export interface CheckpointService {
  create(input: CheckpointCreateParams): Promise<Checkpoint>
  list(workspaceRoot: string, limit?: number): Promise<Checkpoint[]>
  diff(input: CheckpointDiffParams): Promise<string>
  restore(input: CheckpointRestoreParams): Promise<CheckpointRestoreResult>
}

export const CheckpointServiceToken = defineServiceToken<CheckpointService>('checkpoints', 'CheckpointService')
