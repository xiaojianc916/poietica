import { defineCoreModule } from '@poietica/core-kernel'
import { ThreadsRepositoryToken } from '../core-api'
import { createThreadsRepository } from './repository'

/**
 * 线程元数据（P6c）。表名仍是历史 `conversation_threads`：表重命名与旧库迁移在
 * 独立的 schema 窗口完成，这里用 tablePrefix 显式接管，避免一次性跨模块搬家。
 */
export { createThreadsRepository } from './repository'

export default defineCoreModule({
  id: 'threads',
  tablePrefix: 'conversation',
  setup(ctx) {
    ctx.services.provide(ThreadsRepositoryToken, createThreadsRepository(ctx.db))
  },
})
