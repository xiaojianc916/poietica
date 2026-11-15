import type { AgentEvent } from '@poietica/agent-model'
import type { JournalService } from '@poietica/feature-journal/core-api'
import type { Logger } from '@poietica/foundation'
import type { PolicyDecision, PolicyGrant } from '../contract/entities'

/**
 * 策略裁决与授权记录的审计（架构设计 §13.5）：放行 / 拒绝 / 询问、发放放行、撤销放行都写进 Journal。
 * 写失败只记 warn —— 审计掉一条不该让裁决失效或让撤销失败，那会把「记录不上」变成「用不了」。
 *
 * 归属的 threadId 就是 sessionKey（策略门交上来的就是线程键）。没有会话可归属的撤销记在
 * `policy` 这个保留名下：撤销是产品动作，不属于任何一轮对话，但必须留痕。
 */
export interface PolicyAuditDeps {
  readonly journal: JournalService
  readonly logger: Logger
  readonly now: () => number
}

/** 不属于任何线程的产品事件挂在这个 threadId 下（与会话键不会是同一个值：会话键是 createId 的产物）。 */
export const POLICY_AUDIT_THREAD = 'policy'

export interface PolicyDecisionInput {
  readonly sessionKey: string
  readonly toolName: string
  readonly decision: PolicyDecision
  readonly workspaceRoot?: string
  readonly toolCallId?: string
}

export interface PolicyAudit {
  decided(input: PolicyDecisionInput): void
  granted(grant: PolicyGrant): void
  revoked(input: { readonly grantId: string; readonly grant: PolicyGrant | null; readonly removed: boolean }): void
}

export function createPolicyAudit(d: PolicyAuditDeps): PolicyAudit {
  const write = (threadId: string, event: AgentEvent): void => {
    try {
      d.journal.append(threadId, 'main', [event])
    } catch (error) {
      d.logger.warn('policy audit not journaled', { error: String(error), type: event.type })
    }
  }
  const at = (): string => new Date(d.now()).toISOString()

  return {
    decided(input) {
      const { decision } = input
      write(input.sessionKey, {
        type: 'policy.decided',
        schema: 1,
        at: at(),
        durability: 'committed',
        toolName: input.toolName,
        category: decision.classification.category,
        action: decision.action,
        rule: decision.rule,
        reason: decision.reason,
        preset: decision.preset,
        risk: decision.classification.risk,
        ...(input.workspaceRoot === undefined ? {} : { workspaceRoot: input.workspaceRoot }),
        ...(input.toolCallId === undefined ? {} : { toolCallId: input.toolCallId }),
      })
    },
    granted(grant) {
      write(grant.sessionKey, {
        type: 'policy.granted',
        schema: 1,
        at: at(),
        durability: 'committed',
        toolName: grant.toolName,
        grantId: grant.id,
        sessionKey: grant.sessionKey,
        expiresAt: grant.expiresAt,
      })
    },
    revoked(input) {
      write(input.grant?.sessionKey ?? POLICY_AUDIT_THREAD, {
        type: 'policy.revoked',
        schema: 1,
        at: at(),
        durability: 'committed',
        grantId: input.grantId,
        removed: input.removed,
        ...(input.grant === null ? {} : { toolName: input.grant.toolName, sessionKey: input.grant.sessionKey }),
      })
    },
  }
}
