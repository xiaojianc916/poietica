export abstract class DomainError extends Error {
  abstract readonly code: string
  abstract readonly userMessage: string
  readonly timestamp: string
  readonly context: Record<string, unknown> | undefined

  constructor(message: string, context?: Record<string, unknown>) {
    super(message)
    this.name = this.constructor.name
    this.timestamp = new Date().toISOString()
    this.context = context
  }

  toJSON(): ErrorDescriptor {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      timestamp: this.timestamp,
      context: this.context,
    }
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION_ERROR'
  readonly userMessage = '输入数据验证失败，请检查后重试'
  readonly violations: ValidationViolation[]

  constructor(violations: ValidationViolation[], context?: Record<string, unknown>) {
    super('Validation failed', context)
    this.violations = violations
  }
}

export interface ValidationViolation {
  path: string
  message: string
  code: string
  value?: unknown
}

export class InternalInvariantError extends DomainError {
  readonly code = 'INTERNAL_INVARIANT'
  readonly userMessage = '内部错误，请重试或联系支持'
  readonly invariant: string

  constructor(invariant: string, context?: Record<string, unknown>) {
    super(`Invariant violated: ${invariant}`, context)
    this.invariant = invariant
  }
}

export interface ErrorDescriptor {
  readonly code: string
  readonly cause?: unknown
  readonly metadata?: Readonly<Record<string, unknown>>
}

export function assertInvariant(
  condition: unknown,
  invariant: string,
  context?: Record<string, unknown>,
): asserts condition {
  if (!condition) {
    throw new InternalInvariantError(invariant, context)
  }
}

export function assertUnreachable(value: never, context?: Record<string, unknown>): never {
  throw new InternalInvariantError(`Unreachable code reached: ${JSON.stringify(value)}`, context)
}

// NOTE: Domain-specific errors are intentionally NOT defined here. Foundations
// owns only error shapes that every layer shares; anything that names a product
// concept belongs to the package that owns that concept (see
// tools/architecture/rules.config.mjs for the layering).
