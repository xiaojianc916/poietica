/*
 * 不变式断言。
 *
 * 违反不变式是程序错误，当场停住；可分类的运行失败归 failure-kernel.ts。
 */

export function assertInvariant(
  condition: unknown,
  invariant: string,
  context?: Record<string, unknown>,
): asserts condition {
  if (!condition) {
    throw new Error(violation(invariant, context))
  }
}

export function assertUnreachable(value: never, context?: Record<string, unknown>): never {
  throw new Error(violation(`unreachable: ${JSON.stringify(value)}`, context))
}

function violation(invariant: string, context: Record<string, unknown> | undefined): string {
  const said = `Invariant violated: ${invariant}`

  return context === undefined ? said : `${said} ${JSON.stringify(context)}`
}
