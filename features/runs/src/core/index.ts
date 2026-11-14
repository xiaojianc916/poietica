import { defineCoreModule } from '@poietica/core-kernel'
import {
  SessionPoolFactoryToken,
  SubmissionServiceToken,
  SubmissionsRepositoryToken,
  TurnContextRegistryToken,
  TurnServiceToken,
} from '../core-api'
import { createSubmissionsRepository } from './repository'
import { SessionPool } from './session-pool'
import { SubmissionService } from './submission-service'
import { TurnContextHub } from './turn-context'
import { TurnService } from './turn-service'

/**
 * 提交行（P6c）。表名仍是历史 `conversation_submissions`，过渡期显式接管前缀；
 * 表重命名与旧库迁移在独立 schema 窗口完成。
 */
export { createSubmissionsRepository } from './repository'
export const createSessionPool = (deps: ConstructorParameters<typeof SessionPool>[0]): SessionPool =>
  new SessionPool(deps)

export default defineCoreModule({
  id: 'runs',
  tablePrefix: 'conversation',
  setup(ctx) {
    const repo = createSubmissionsRepository(ctx.db)
    ctx.services.provide(SubmissionsRepositoryToken, repo)
    ctx.services.provide(SubmissionServiceToken, new SubmissionService({ repo, clock: ctx.clock, logger: ctx.logger }))
    ctx.services.provide(SessionPoolFactoryToken, createSessionPool)
    ctx.services.provide(TurnContextRegistryToken, new TurnContextHub(ctx.logger))
    ctx.services.provide(TurnServiceToken, new TurnService({ clock: ctx.clock, logger: ctx.logger }))
  },
})

export { eventsFromPage, pagesToPage } from './journal-rebuild'
export { IDLE_TTL_MS, MAX_IDLE_SESSIONS, SessionPool, SWEEP_INTERVAL_MS } from './session-pool'
export { SubmissionService } from './submission-service'
export { TURN_CONTEXT_MAX, TurnContextHub } from './turn-context'
export { pageFromJournal, TurnService } from './turn-service'
