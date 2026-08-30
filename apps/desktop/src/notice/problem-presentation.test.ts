import { describe, expect, it } from 'bun:test'
import { FailureCoordinator, type TerminalFailureIncident } from '@poietica/problem'

import {
  APPLICATION_FAILURE_CODES,
  APPLICATION_FAILURE_POLICIES,
  createTerminalFailureViewModel,
  DEGRADABLE_FEATURE_IDS,
} from './problem-presentation'

/**
 * The declared set of degradable features and the policies that degrade them
 * are two halves of one statement, and they drift apart silently: a policy
 * pointing at an undeclared feature disables a control nothing will ever
 * restore, and a declared feature nothing degrades is a promise about a
 * behaviour that does not exist.
 */

const degradableCodes = APPLICATION_FAILURE_CODES.filter(
  (code) => APPLICATION_FAILURE_POLICIES[code].recovery === 'disable-feature',
)

const usedFeatureIds = new Set(
  degradableCodes.flatMap((code) => {
    const scope = APPLICATION_FAILURE_POLICIES[code].scope({})
    return scope.kind === 'feature' ? [scope.featureId] : []
  }),
)

describe('Git branch operation failures', () => {
  it('remain retryable without degrading the Git feature', () => {
    const policy = APPLICATION_FAILURE_POLICIES.GIT_BRANCH_OPERATION_FAILED

    expect(policy.impact).toBe('recoverable')
    expect(policy.recovery).toBe('retry')
    expect(policy.scope({})).toEqual({
      kind: 'operation',
      operation: 'git-branch-operation',
    })
  })
})

describe('the features this application knows how to lose', () => {
  it('has policies to lose them with', () => {
    expect(degradableCodes.length).toBeGreaterThan(0)
    expect(DEGRADABLE_FEATURE_IDS.length).toBeGreaterThan(0)
  })

  it('declares exactly the features it degrades', () => {
    expect([...usedFeatureIds].sort()).toEqual([...DEGRADABLE_FEATURE_IDS].sort())
  })

  it('gives every disable-feature policy a feature to disable', () => {
    for (const code of degradableCodes) {
      expect(APPLICATION_FAILURE_POLICIES[code].scope({}).kind).toBe('feature')
    }
  })
})

describe('createTerminalFailureViewModel', () => {
  it('projects application fatal state', () => {
    const incident = createTerminalIncident({
      impact: 'application-fatal',

      code: 'APPLICATION_FATAL',

      userMessage: '应用无法继续运行。',

      recovery: 'reload',

      scope: {
        kind: 'application',
      },

      cause: new Error('render failed'),
    })

    const model = createTerminalFailureViewModel(incident)

    expect(model.title).toBe('应用遇到严重错误')

    expect(model.description).toBe('应用无法继续运行。')

    expect(model.primaryAction).toEqual({
      kind: 'reload',
      label: '重新加载',
    })

    expect(model.summary).toBe('render failed')

    expect(model.diagnostic).toContain('render failed')
  })

  it('shortens long technical messages', () => {
    const incident = createTerminalIncident({
      impact: 'application-fatal',

      code: 'LONG_MESSAGE_FATAL',

      userMessage: '应用无法继续运行。',

      recovery: 'reload',

      scope: {
        kind: 'application',
      },

      cause: new Error('x'.repeat(200)),
    })

    const model = createTerminalFailureViewModel(incident)

    expect(model.summary).toBe(`${'x'.repeat(159)}…`)
  })

  it('projects native fatal state', () => {
    const incident = createTerminalIncident({
      impact: 'native-fatal',

      code: 'NATIVE_PROCESS_FATAL',

      userMessage: '应用上次运行时异常终止。',

      recovery: 'reload',

      scope: {
        kind: 'native-process',
      },

      cause: new Error('native panic'),
    })

    const model = createTerminalFailureViewModel(incident)

    expect(model.title).toBe('应用上次异常终止')
  })

  it('uses an explicit presentation title', () => {
    const incident = createTerminalIncident({
      impact: 'application-fatal',

      code: 'CUSTOM_FATAL',

      userMessage: '应用无法继续运行。',

      recovery: 'reload',

      scope: {
        kind: 'application',
      },

      cause: new Error('failure'),

      context: {
        presentationTitle: '无法完成应用启动',
      },
    })

    const model = createTerminalFailureViewModel(incident)

    expect(model.title).toBe('无法完成应用启动')
  })

  it('projects additional incident count', () => {
    const incident = createTerminalIncident({
      impact: 'application-fatal',

      code: 'PRIMARY_FATAL',

      userMessage: '应用无法继续运行。',

      recovery: 'reload',

      scope: {
        kind: 'application',
      },

      cause: new Error('failure'),
    })

    const model = createTerminalFailureViewModel(incident, 3)

    expect(model.additionalIncidentMessage).toBe('此后还捕获到 3 个相关异常。')
  })

  it('does not invent unsupported actions', () => {
    const incident = createTerminalIncident({
      impact: 'application-fatal',

      code: 'NO_RECOVERY_FATAL',

      userMessage: '应用无法继续运行。',

      recovery: 'none',

      scope: {
        kind: 'application',
      },

      cause: new Error('failure'),
    })

    const model = createTerminalFailureViewModel(incident)

    expect(model.primaryAction).toBeNull()
  })
})

function createTerminalIncident(
  signal: Parameters<FailureCoordinator['report']>[0],
): TerminalFailureIncident {
  const coordinator = new FailureCoordinator()

  coordinator.report(signal)

  const terminal = coordinator.getSnapshot().terminal

  if (!terminal) {
    throw new Error('Expected terminal failure state.')
  }

  return terminal.incident
}
