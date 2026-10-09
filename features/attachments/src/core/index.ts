import { defineCoreModule } from '@poietica/core-kernel'
import { attachmentsContract } from '../contract'
import { AttachmentsServiceToken } from '../core-api'
import { registerHandlers } from './handlers'
import { migrations } from './migrations'
import { createAttachmentsRepository } from './repository'
import { createAttachmentsService, SWEEP_FIRST_DELAY_MS, SWEEP_INTERVAL_MS } from './service'

export default defineCoreModule({
  id: 'attachments',
  contract: attachmentsContract,
  migrations,
  setup(ctx) {
    const service = createAttachmentsService({
      repo: createAttachmentsRepository(ctx.db),
      dir: ctx.layout.attachmentsDir,
      clock: ctx.clock,
      logger: ctx.logger,
    })

    registerHandlers(ctx, service)
    ctx.services.provide(AttachmentsServiceToken, {
      resolve: service.resolve,
      describe: service.describe,
      retain: service.retain,
      releaseOwner: service.releaseOwner,
    })

    // 回收：onReady 后 60 秒第一次，此后每 6 小时一次（定时器一律走 ctx.clock）
    ctx.lifecycle.onReady(() => {
      const run = (): void => {
        void service.sweep().catch((e: unknown) => {
          ctx.logger.warn('attachment sweep failed', { error: String(e) })
        })
      }
      const first = ctx.clock.setTimeout(() => {
        run()
        const repeating = ctx.clock.setInterval(run, SWEEP_INTERVAL_MS)
        ctx.disposables.add(repeating)
      }, SWEEP_FIRST_DELAY_MS)
      ctx.disposables.add(first)
    })
  },
})
