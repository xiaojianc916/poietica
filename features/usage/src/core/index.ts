import { defineCoreModule } from '@poietica/core-kernel'
import {
  USAGE_SAMPLED_TOPIC,
  USER_MESSAGE_SUBMITTED_TOPIC,
  usageSampledPayload,
  userMessageSubmittedPayload,
} from '@poietica/feature-conversation/core-api'
import { usageContract } from '../contract'
import { migrations } from './migrations'
import { createUsageRepo, localDay } from './repo'

export default defineCoreModule({
  id: 'usage',
  contract: usageContract,
  dependsOn: ['conversation'],
  migrations,
  setup(ctx) {
    const repo = createUsageRepo(ctx.db)
    /* 采样落账。outbox 至少一次投递，仓库用唯一键去重；设置页那三张图直接查账。 */
    ctx.outboxHandlers.register(USAGE_SAMPLED_TOPIC, (payload) => {
      const { eventId, threadId, sample } = usageSampledPayload.parse(payload)
      repo.insert({ eventId, threadId, day: localDay(sample.at), ...sample })
    })
    ctx.outboxHandlers.register(USER_MESSAGE_SUBMITTED_TOPIC, (payload) => {
      repo.insertMessage(userMessageSubmittedPayload.parse(payload))
    })

    ctx.rpc.handle('usage.tokenDays', (p) => {
      const days = repo
        .tokenDays(p.from, p.to)
        .map((d) => ({ day: d.day, tokens: d.input + d.output + d.cacheRead + d.cacheWrite }))
      return { days }
    })
    ctx.rpc.handle('usage.modelDays', (p) => {
      const rows = repo
        .modelDays(p.from, p.to)
        .map((d) => ({ day: d.day, model: `${d.provider}/${d.model}`, tokens: d.input + d.output }))
      return { rows }
    })
    ctx.rpc.handle('usage.messageCount', (p) => {
      return { days: repo.messageCount(p.from, p.to) }
    })
  },
})
