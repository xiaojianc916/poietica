import type { UsageSample } from '@poietica/engine'
import type { ModuleDatabase } from '@poietica/storage-sqlite'

export function localDay(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function createUsageRepo(db: ModuleDatabase) {
  const ins =
    db.prepare(`INSERT INTO usage_events (thread_id, day, at, provider, model, input, output, cache_read, cache_write, cost)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  const insMessage = db.prepare('INSERT INTO usage_messages (thread_id, day, at) VALUES (?, ?, ?)')
  return {
    insert(r: { threadId: string; day: string } & UsageSample): void {
      ins.run(r.threadId, r.day, r.at, r.provider, r.model, r.input, r.output, r.cacheRead, r.cacheWrite, r.cost)
    },
    /** 用户发出去一句话（准入）—— 数的是它，不是模型采样条数（ADR 0039）。 */
    insertMessage(r: { threadId: string; at: number }): void {
      insMessage.run(r.threadId, localDay(r.at), r.at)
    },
    tokenDays(from: string, to: string) {
      return db
        .prepare(
          `SELECT day, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cacheRead,
                                SUM(cache_write) AS cacheWrite, SUM(cost) AS cost
                         FROM usage_events WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`,
        )
        .all(from, to) as Array<{
        day: string
        input: number
        output: number
        cacheRead: number
        cacheWrite: number
        cost: number
      }>
    },
    modelDays(from: string, to: string) {
      return db
        .prepare(
          `SELECT day, provider, model, SUM(input) AS input, SUM(output) AS output, SUM(cost) AS cost
                         FROM usage_events WHERE day BETWEEN ? AND ? GROUP BY day, provider, model ORDER BY day, provider, model`,
        )
        .all(from, to) as Array<{
        day: string
        provider: string
        model: string
        input: number
        output: number
        cost: number
      }>
    },
    /** 按天统计用户发出的消息数（ADR 0039）。数的是 usage_messages 那张**准入账**，不是 usage_events 的采样条数：一次用户输入会引出多次
     * 模型调用，按采样数会把「消息数量」放大约一个数量级。插话也过准入，所以照算。 */
    messageCount(from: string, to: string) {
      return db
        .prepare(
          `SELECT day, COUNT(*) AS count FROM usage_messages WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`,
        )
        .all(from, to) as Array<{ day: string; count: number }>
    },
  }
}
