import type { Problem } from '@poietica/contract'

import { PROBLEM_COPY } from './copy.ts'

export type { Problem }

/** 原生侧抛过来的是裸对象，不是 Error 实例，只能按形状认。 */
export function isProblem(value: unknown): value is Problem {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Record<string, unknown>

  return (
    typeof candidate['code'] === 'string' &&
    typeof candidate['category'] === 'string' &&
    typeof candidate['retryability'] === 'string' &&
    typeof candidate['userMessageKey'] === 'string' &&
    typeof candidate['diagnosticId'] === 'string' &&
    typeof candidate['details'] === 'object' &&
    candidate['details'] !== null
  )
}

/** 一次失败在前端只有这一个类型。 */
export class ProblemError extends Error {
  readonly problem: Problem

  constructor(problem: Problem) {
    super(sentence(problem))
    this.name = 'ProblemError'
    this.problem = problem
  }
}

/** 自带理由的说理由，其余说文案目录里的那一句。 */
export function sentence(problem: Problem): string {
  const reason = problem.details['reason']

  if (typeof reason === 'string' && reason.length > 0) {
    return reason
  }

  return PROBLEM_COPY[problem.userMessageKey] ?? PROBLEM_COPY['problem.internal'] ?? problem.code
}
