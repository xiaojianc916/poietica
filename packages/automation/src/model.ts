/* Domain-owned vocabulary. The native bridge translates generated wire DTOs at the process boundary. */
export type Automation = {
  id: string
  title: string
  /**
   * 到期时发给 agent 的那句话。自动化的全部行为都由它决定。
   */
  prompt: string
  /**
   * 什么时候跑。crontab 表达式；None 就是「只在人按下运行时跑一次」。
   *
   * 这一侧不解析它。这一侧只有一个职责：把 next_run_at 和墙钟比大小
   * （见 due_at）。日历是领域的事，归 packages/automations，那里用 croner
   * 求值。
   *
   * 时区不在这里，也不在任何一个字段里：求值那一刻的系统时区就是答案。
   * 存一份下来，总有一天会和人所在的地方对不上，而「每天九点」说的永远
   * 是此刻这台机器上的九点。
   *
   * Option 而不是一个带 Manual 分支的判别联合：Manual 不携带任何数据，
   * 那个 tag 只是 None 的另一种拼法，两份表示就是两份能互相矛盾的真相。
   */
  schedule: string | null
  enabled: boolean
  createdAt: string
  /**
   * 下一次到期的时刻，RFC 3339；manual 为 None。
   *
   * 它是被存下来的状态，不是每次由 last_run 推出来的推论：只有存下来，
   * 关机三天之后再打开才分得清「这次错过了」与「刚刚才排上」。cron 守护
   * 进程与 Temporal 这类调度器的做法都是如此。
   */
  nextRunAt: string | null
  /**
   * 这次运行要改掉的会话设置，按 agent 报的 controlId 记。
   *
   * 值是 agent 自己的词汇（模型别名、推理档位、模式），这一层不认识也不
   * 校验：候选由它在 session/new 里报出，随时可能改名或撤回。空表就是
   * 「跟随全局默认」，所以缺席与空表是同一个意思，serde(default) 足够。
   *
   * BTreeMap 而非 HashMap：写进 JSON 的键序要稳定，否则每次保存都是一次
   * 无意义的磁盘差异。生成的 TypeScript 因此是 Partial<Record<..>>。
   */
  sessionConfig?: Partial<{ [key in string]: string }>
  /**
   * 运行账本。归这一侧所有 —— 见 automations_upsert。
   */
  runs: AutomationRun[]
}
export type AutomationCatalog = { version: number; automations: Automation[] }
export type AutomationCreation = {
  title: string
  prompt: string
  schedule: string | null
  sessionConfig?: Partial<{ [key in string]: string }>
  nextRunAt: string | null
}
export type AutomationReschedule =
  | { kind: 'keep' }
  | { kind: 'advance'; from: string; to: string | null }
export type AutomationRun = {
  /**
   * 这次运行开出来的那条对话。开不出来时为 None。
   */
  threadId: string | null
  /**
   * RFC 3339。全库其余每一处时间戳都是这个格式。
   */
  startedAt: string
  outcome: AutomationRunOutcome
}
export type AutomationRunOutcome = 'succeeded' | 'failed'
export type AutomationRunRecord = {
  id: string
  run: AutomationRun
  reschedule: AutomationReschedule
}
