import { defineCoreModule } from '@poietica/core-kernel'
import { CheckpointServiceToken } from '../core-api'

/** 测试替身：轮次开始会找检查点服务，对话类测试不碰真实 git。 */
export const checkpointsTestModule = defineCoreModule({
  id: 'checkpoints',
  setup(ctx) {
    ctx.services.provide(CheckpointServiceToken, {
      create: async (input) => ({
        id: 'test',
        workspaceRoot: input.workspaceRoot,
        createdAt: new Date().toISOString(),
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
        ...(input.runId === undefined ? {} : { runId: input.runId }),
        ...(input.stepId === undefined ? {} : { stepId: input.stepId }),
        ...(input.label === undefined ? {} : { label: input.label }),
      }),
      list: async () => [],
      diff: async () => '',
      diffPaths: async () => [],
      changedPaths: async () => [],
      restore: async (input) => ({ restored: input.paths }),
    })
  },
})
