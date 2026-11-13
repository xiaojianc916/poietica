import { defineCoreModule } from '@poietica/core-kernel'
import { SessionPoolFactoryToken, SubmissionsRepositoryToken, TurnContextRegistryToken } from '../core-api'
import { createSubmissionsRepository } from './repository'
import { SessionPool } from './session-pool'
import { TurnContextHub } from './turn-context'

/**
 * 提交行（P6c）。表名仍是历史 `conversation_submissions`，过渡期显式接管前缀；
 * 表重命名与旧库迁移在独立 schema 窗口完成。
 */
export { createSubmissionsRepository } from './repository'

export default defineCoreModule({
  id: 'runs',
  tablePrefix: 'conversation',
  setup(ctx) {
    ctx.services.provide(SubmissionsRepositoryToken, createSubmissionsRepository(ctx.db))
    ctx.services.provide(SessionPoolFactoryToken, (deps) => new SessionPool(deps))
    ctx.services.provide(TurnContextRegistryToken, new TurnContextHub(ctx.logger))
  },
})

export { IDLE_TTL_MS, MAX_IDLE_SESSIONS, SessionPool, SWEEP_INTERVAL_MS } from './session-pool'
export const createSessionPool = (deps: ConstructorParameters<typeof SessionPool>[0]): SessionPool =>
  new SessionPool(deps)

export { TURN_CONTEXT_MAX, TurnContextHub } from './turn-context'
