import { defineCoreModule } from '@poietica/core-kernel'
import {
  ConversationServiceToken,
  type SubmissionFailed,
  submissionFailed,
  THREAD_REMOVED_TOPIC,
  type TurnSettled,
  threadRemovedPayload,
  turnSettled,
} from '@poietica/feature-conversation/core-api'
import {
  WORKSPACE_REMOVED_TOPIC,
  WorkspacesServiceToken,
  workspaceRemovedPayload,
} from '@poietica/feature-workspaces/core-api'
import { automationsContract } from '../contract'
import { registerAgentTools } from './agent-tools'
import { registerHandlers } from './handlers'
import { migrations } from './migrations'
import { createAutomationsRepository } from './repository'
import { createRunner } from './runner'
import { createScheduler } from './scheduler'
import { createAutomationsService } from './service'
import { localTimeZone } from './time'

export default defineCoreModule({
  id: 'automations',
  contract: automationsContract,
  dependsOn: ['conversation', 'workspaces'],
  migrations,
  setup(ctx) {
    const repo = createAutomationsRepository(ctx.db)
    const conversation = ctx.services.get(ConversationServiceToken)
    const workspaces = ctx.services.get(WorkspacesServiceToken)

    const runner = createRunner({
      repo,
      conversation,
      workspaces,
      clock: ctx.clock,
      logger: ctx.logger,
      emitRunUpdated: (run) => ctx.rpc.emit('automations.runUpdated', run),
      emitAttention: (attention) => ctx.rpc.emit('automations.attention', attention),
      emitChanged: () => ctx.rpc.emit('automations.changed', {}),
    })
    const scheduler = createScheduler({ repo, runner, clock: ctx.clock, logger: ctx.logger })
    const service = createAutomationsService({ repo, runner, conversation, clock: ctx.clock, logger: ctx.logger })

    registerHandlers(ctx, service)
    registerAgentTools({
      tools: ctx.agentTools,
      service,
      conversation,
      workspaces,
      agentRuntime: ctx.agentRuntime.sessions,
      clock: ctx.clock,
      localTimeZone,
    })

    ctx.disposables.add(
      ctx.events.on<TurnSettled>(turnSettled, (e) => {
        runner.onTurnSettled(e)
      }),
    )

    ctx.disposables.add(
      ctx.events.on<SubmissionFailed>(submissionFailed, (e) => {
        runner.onSubmissionFailed(e)
      }),
    )
    ctx.outboxHandlers.register(THREAD_REMOVED_TOPIC, (payload) => {
      const e = threadRemovedPayload.parse(payload)
      runner.onThreadRemoved(e)
      if (repo.clearThread(e.threadId, ctx.clock.now()) > 0) ctx.rpc.emit('automations.changed', {})
    })

    ctx.outboxHandlers.register(WORKSPACE_REMOVED_TOPIC, (payload) => {
      const e = workspaceRemovedPayload.parse(payload)
      repo.removeByWorkspace(e.workspaceId)
      ctx.rpc.emit('automations.changed', {})
    })

    ctx.lifecycle.onReady(() => {
      /* 库只读（ADR-004）：不修账、不排程 —— 两样都要写库；列表照常能看 */
      if (ctx.runtime.dataMode.mode === 'readOnly') {
        ctx.logger.warn('automations paused: database is read-only', { reason: ctx.runtime.dataMode.reason })
        return
      }
      scheduler.repairOnStartup()
      ctx.disposables.add(scheduler.start())
      ctx.rpc.emit('automations.changed', {})
    })

    ctx.lifecycle.onShutdown(() => {
      runner.dispose()
    })
  },
})
