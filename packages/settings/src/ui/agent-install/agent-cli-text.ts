/*
 * agent 相关操作的失败怎么说给用户听。
 *
 * 只有 Error 才有可信的 message；agent 拒绝时写进 Error 的那句话（含 stderr 转述）
 * 比我们现编一句更准确，直接转述。装不上与写配置两个入口共用这一条。
 */

export function describeAgentCliFailure(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback
}
