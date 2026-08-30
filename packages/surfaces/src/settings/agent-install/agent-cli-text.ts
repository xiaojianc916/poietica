/*
 * agent CLI 的失败怎么说给用户听。
 *
 * 两条判断曾各写一份在用到它们的地方。它们不属于任何一个 hook：所有 execCli 调用共用
 * 同一套 —— 非零退出优先转述 agent 自己的 stderr（config.toml 坏掉时它说得比我们清楚，
 * 连怎么修都写了，转述一遍只会丢信息），异常时只有 Error 才有可信的 message。
 */

/**
 * agent 拒绝这一次调用时说了什么。
 *
 * 此前这件事有两份实现：这里的 describeAgentCliExit 只读 stderr，AgentModels 里的
 * reasonOf 先读 stderr 再读 stdout。于是同一个失败在两张卡上说两种话 —— 一个把 agent
 * 写在 stdout 上的原因显示出来，另一个只显示「退出码 1」。两份都不完整，合成一份。
 *
 * 取第一条非空行：agent 的 CLI 在诊断后面还会跟一整段用法说明，整段贴到界面上没人读。
 */
export function describeAgentCliOutcome(outcome: {
  readonly status: number
  readonly stdout: string
  readonly stderr: string
}): string {
  const spoken = [outcome.stderr, outcome.stdout]
    .flatMap((stream) => stream.split('\n'))
    .map((line) => line.trim())
    .find((line) => line.length > 0)

  return spoken ?? `agent 以退出码 ${outcome.status} 结束，且没有说明原因。`
}

export function describeAgentCliFailure(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
