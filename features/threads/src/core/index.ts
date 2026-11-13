import { defineCoreModule } from '@poietica/core-kernel'
import { ThreadsRepositoryToken, ThreadsServiceToken } from '../core-api'
import { createReclaimRepository } from './reclaim-repository'
import { createThreadsRepository } from './repository'
import { ThreadService } from './thread-service'

export { createReclaimRepository } from './reclaim-repository'
/**
 * 线程元数据（P6c）。表名仍是历史 `conversation_threads`：表重命名与旧库迁移在
 * 独立的 schema 窗口完成，这里用 tablePrefix 显式接管，避免一次性跨模块搬家。
 */
export { createThreadsRepository } from './repository'
export { ThreadService } from './thread-service'

export default defineCoreModule({
  id: 'threads',
  tablePrefix: 'conversation',
  setup(ctx) {
    const repo = createThreadsRepository(ctx.db)
    ctx.services.provide(ThreadsRepositoryToken, repo)
    ctx.services.provide(
      ThreadsServiceToken,
      new ThreadService({
        repo,
        reclaim: createReclaimRepository(ctx.db),
        transaction: (fn) => ctx.db.transaction(fn),
        clock: ctx.clock,
        logger: ctx.logger,
      }),
    )
  },
})
