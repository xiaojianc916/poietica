import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import {
  Checkpoint,
  CheckpointCreateParams,
  CheckpointDiffParams,
  CheckpointListParams,
  CheckpointRestoreParams,
  CheckpointRestoreResult,
} from './entities'
import { checkpointErrors } from './errors'

export * from './entities'
export { checkpointErrors } from './errors'

export const checkpointsContract = defineContract({
  id: 'checkpoints',
  namespaces: ['checkpoints'],
  methods: [
    defineMethod({
      name: 'checkpoints.create',
      owner: 'core',
      params: CheckpointCreateParams,
      result: Checkpoint,
      description: '给工作树打一个影子检查点；轮次开始与每次写型工具之后调用',
    }),
    defineMethod({
      name: 'checkpoints.list',
      owner: 'core',
      params: CheckpointListParams,
      result: z.array(Checkpoint),
      description: '倒序列出某个工作区的检查点',
    }),
    defineMethod({
      name: 'checkpoints.diff',
      owner: 'core',
      params: CheckpointDiffParams,
      result: z.string(),
      description: '两个检查点之间的完整 diff（包含 shell 造成的改动）',
    }),
    defineMethod({
      name: 'checkpoints.restore',
      owner: 'core',
      params: CheckpointRestoreParams,
      result: CheckpointRestoreResult,
      description: '把指定路径恢复到某检查点；工作树有手动改动时拒绝',
    }),
  ],
  notifications: [],
  errors: checkpointErrors,
})
