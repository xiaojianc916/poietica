import { v7 as uuidv7 } from 'uuid'
import { assertInvariant } from './errors'
import { optionalProperty } from './optional-property'

export const FAILURE_IMPACTS = [
  'recoverable',
  'feature-degraded',
  'application-fatal',
  'native-fatal',
] as const

export type FailureImpact = (typeof FAILURE_IMPACTS)[number]

export type NonTerminalFailureImpact = Extract<FailureImpact, 'recoverable' | 'feature-degraded'>

export type TerminalFailureImpact = Extract<FailureImpact, 'application-fatal' | 'native-fatal'>

export type FailureRecovery =
  | 'retry'
  | 'dismiss'
  | 'disable-feature'
  | 'reload'
  | 'restart'
  | 'exit'
  | 'none'

export type FailureScope =
  | { readonly kind: 'operation'; readonly operation: string }
  | { readonly kind: 'feature'; readonly featureId: string }
  | { readonly kind: 'application' }
  | { readonly kind: 'native-process' }

export interface ClassifiedFailureInput {
  readonly impact: FailureImpact
  readonly code: string
  readonly userMessage: string
  readonly technicalMessage: string
  readonly scope: FailureScope
  readonly recovery: FailureRecovery
  readonly cause?: unknown
  readonly context?: Readonly<Record<string, unknown>>
}

export interface ClassifiedFailure {
  readonly id: string
  readonly fingerprint: string
  readonly impact: FailureImpact
  readonly code: string
  readonly userMessage: string
  readonly technicalMessage: string
  readonly scope: FailureScope
  readonly recovery: FailureRecovery
  readonly occurredAt: string
  readonly cause?: unknown
  readonly context: Readonly<Record<string, unknown>>
}

const RECOVERY_BY_IMPACT = {
  recoverable: new Set<FailureRecovery>(['retry', 'dismiss', 'none']),
  'feature-degraded': new Set<FailureRecovery>(['retry', 'dismiss', 'disable-feature', 'none']),
  'application-fatal': new Set<FailureRecovery>(['reload', 'restart', 'exit', 'none']),
  'native-fatal': new Set<FailureRecovery>(['reload', 'restart', 'exit', 'none']),
} satisfies Record<FailureImpact, ReadonlySet<FailureRecovery>>

/**
 * 每个 impact 允许哪些 scope，以及违反时说什么 —— 规则和它的说法放在一起。
 *
 * message 是写死的句子，不是从 impact 拼出来的。impact 是给机器看的标识符，
 * 错误文案是给人看的规约：它会进日志和崩溃上报，不应该因为将来重命名一个
 * 枚举成员就跟着变形。表格化要的是"加 impact 不用再抄一遍分支"，
 * 不是"把文案也变成派生物"。
 */
const SCOPE_RULES = {
  recoverable: {
    allowed: new Set<FailureScope['kind']>(['operation', 'feature']),
    message: 'Recoverable failure cannot own an application or native-process scope.',
  },
  'feature-degraded': {
    allowed: new Set<FailureScope['kind']>(['feature']),
    message: 'Feature-degraded failure requires a feature scope.',
  },
  'application-fatal': {
    allowed: new Set<FailureScope['kind']>(['application']),
    message: 'Application-fatal failure requires an application scope.',
  },
  'native-fatal': {
    allowed: new Set<FailureScope['kind']>(['native-process']),
    message: 'Native-fatal failure requires a native-process scope.',
  },
} satisfies Record<
  FailureImpact,
  { readonly allowed: ReadonlySet<FailureScope['kind']>; readonly message: string }
>

export function createClassifiedFailure(input: ClassifiedFailureInput): ClassifiedFailure {
  validateFailurePolicy(input)

  const scopeKey = createFailureScopeKey(input.scope)

  return Object.freeze({
    /*
     * 身份就是 uuid v7：单调、无需协调、跨进程唯一。
     * 之前用的是「时间戳 + 模块级计数器 + Math.random」—— 那个计数器在 HMR
     * 或多份 bundle 实例下各自从 0 开始，它想保证的唯一性恰恰保证不了，
     * 而同包 id.ts 早就在用 v7 解决同一个问题。
     */
    id: uuidv7(),
    fingerprint: [input.impact, input.code, scopeKey, input.technicalMessage].join('|'),
    impact: input.impact,
    code: input.code,
    userMessage: input.userMessage,
    technicalMessage: input.technicalMessage,
    scope: Object.freeze(input.scope),
    recovery: input.recovery,
    occurredAt: new Date().toISOString(),
    ...optionalProperty('cause', input.cause),
    context: Object.freeze({ ...(input.context ?? {}) }),
  })
}

export function isTerminalFailureImpact(impact: FailureImpact): impact is TerminalFailureImpact {
  return impact === 'application-fatal' || impact === 'native-fatal'
}

export function isNonTerminalFailureImpact(
  impact: FailureImpact,
): impact is NonTerminalFailureImpact {
  return !isTerminalFailureImpact(impact)
}

export function createFailureScopeKey(scope: FailureScope): string {
  switch (scope.kind) {
    case 'operation':
      return `operation:${scope.operation}`
    case 'feature':
      return `feature:${scope.featureId}`
    case 'application':
      return 'application'
    case 'native-process':
      return 'native-process'
  }
}

/**
 * 违反这些规则的不是用户，是调用它的代码 —— 所以抛的是不变量错误，
 * 而不是同包 errors.ts 里为输入校验准备的校验错误，
 * 更不是之前那种没有 code、没有 context、无法被上层分类的裸 Error。
 */
export function validateFailurePolicy(input: ClassifiedFailureInput): void {
  assertInvariant(input.code.trim().length > 0, 'Failure code must not be empty.')

  assertInvariant(input.userMessage.trim().length > 0, 'Failure userMessage must not be empty.')

  assertInvariant(
    input.technicalMessage.trim().length > 0,
    'Failure technicalMessage must not be empty.',
  )

  assertInvariant(
    RECOVERY_BY_IMPACT[input.impact].has(input.recovery),
    `Recovery ${input.recovery} is invalid for impact ${input.impact}.`,
    { impact: input.impact, recovery: input.recovery },
  )

  const scopeRule = SCOPE_RULES[input.impact]

  assertInvariant(scopeRule.allowed.has(input.scope.kind), scopeRule.message, {
    impact: input.impact,
    scope: input.scope.kind,
  })
}
