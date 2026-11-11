import path from 'node:path'
import { defineCoreModule } from '@poietica/core-kernel'
import { checkpointsContract } from '../contract'
import { CheckpointServiceToken } from '../core-api'
import { createCheckpointService } from './checkpoints'

export default defineCoreModule({
  id: 'checkpoints',
  contract: checkpointsContract,
  setup(ctx) {
    const service = createCheckpointService({ dir: path.join(ctx.layout.root, 'checkpoints') })
    ctx.services.provide(CheckpointServiceToken, service)
    ctx.rpc.handle('checkpoints.create', (input) => service.create(input))
    ctx.rpc.handle('checkpoints.list', ({ workspaceRoot, limit }) => service.list(workspaceRoot, limit))
    ctx.rpc.handle('checkpoints.diff', (input) => service.diff(input))
    ctx.rpc.handle('checkpoints.restore', (input) => service.restore(input))
  },
})
