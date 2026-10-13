import { defineCoreModule } from '@poietica/core-kernel'
import { usageSampled, userMessageSubmitted } from '@poietica/feature-conversation/core-api'
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
    /* 采样落账。落账与通知无关：设置页那三张图直接查账，不靠推送重读。 */
    ctx.disposables.add(
      ctx.events.on(usageSampled, ({ threadId, sample }) => {
        repo.insert({ threadId, day: localDay(sample.at), ...sample })
      }),
    )
    ctx.disposables.add(ctx.events.on(userMessageSubmitted, (p) => repo.insertMessage(p)))

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
