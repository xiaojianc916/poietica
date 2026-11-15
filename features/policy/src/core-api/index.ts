import { defineServiceToken } from '@poietica/foundation'
import type { PolicyContext, PolicyDecision, PolicyGrant, PolicyPreset, ToolClassification } from '../contract/entities'

/** 一次裁决请求：引擎钩子与 `policy.check` RPC 用的是同一份形状。 */
export interface PolicyCheckInput {
  readonly sessionKey: string
  readonly preset: PolicyPreset
  readonly toolName: string
  readonly context?: PolicyContext
  /** 产品工具自报的分类（按 spec.approval 映射）；不给就按工具名查表 */
  readonly classification?: ToolClassification
  /** omp 的工具调用号；有就记进审计，把它挂回时间线那一格 */
  readonly toolCallId?: string
}

export interface PolicyService {
  /** 纯裁决，不留痕（要留痕走 check） */
  evaluate(preset: PolicyPreset, toolName: string, context?: PolicyContext): PolicyDecision
  evaluateClassification(
    preset: PolicyPreset,
    classification: ToolClassification,
    context?: PolicyContext,
  ): PolicyDecision
  /**
   * 裁决 + 本会话放行覆盖 + 审计：引擎钩子与 RPC 都走这一条。
   * 「本会话已放行」是策略自己的一条规则（不是调用方的事），所以理由与规则码在这里定。
   */
  check(input: PolicyCheckInput): PolicyDecision
  /** 本会话放行某工具；默认 24 小时后过期（进程重启后仍生效），并写一条 policy.granted。 */
  grant(input: { readonly sessionKey: string; readonly toolName: string }): PolicyGrant
  grants(): readonly PolicyGrant[]
  /** 撤销并写一条 policy.revoked（记下被撤销的是哪个工具、属于哪个会话） */
  revoke(grantId: string): boolean
  isGranted(sessionKey: string, toolName: string): boolean
}

export const PolicyServiceToken = defineServiceToken<PolicyService>('policy', 'PolicyService')
