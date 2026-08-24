import { describe, expect, it } from 'bun:test'
import { FailureCoordinator } from './coordinator'

describe('FailureCoordinator', () => {
  it('owns recoverable failures', () => {
    const coordinator = new FailureCoordinator()

    coordinator.report({
      impact: 'recoverable',
      code: 'SAVE_FAILED',
      userMessage: '保存失败。',
      cause: new Error('disk failure'),
      scope: {
        kind: 'operation',
        operation: 'save',
      },
      recovery: 'retry',
    })

    expect(coordinator.getSnapshot().operations).toHaveLength(1)

    expect(coordinator.getSnapshot().terminal).toBeNull()
  })

  it('owns feature degradation', () => {
    const coordinator = new FailureCoordinator()

    coordinator.report({
      impact: 'feature-degraded',
      code: 'SETTINGS_UNAVAILABLE',
      userMessage: '设置暂时不可用。',
      cause: new Error('settings'),
      scope: {
        kind: 'feature',
        featureId: 'settings',
      },
      recovery: 'disable-feature',
    })

    expect(coordinator.getSnapshot().degradedFeatures.has('settings')).toBe(true)
  })

  it('locks the first terminal failure', () => {
    const coordinator = new FailureCoordinator()

    const first = coordinator.report({
      impact: 'application-fatal',
      code: 'FIRST_FATAL',
      userMessage: '应用无法继续。',
      cause: new Error('first'),
      scope: {
        kind: 'application',
      },
      recovery: 'reload',
    })

    coordinator.report({
      impact: 'application-fatal',
      code: 'SECOND_FATAL',
      userMessage: '应用无法继续。',
      cause: new Error('second'),
      scope: {
        kind: 'application',
      },
      recovery: 'reload',
    })

    const terminal = coordinator.getSnapshot().terminal

    expect(terminal?.incident.id).toBe(first.id)

    expect(terminal?.additionalIncidentCount).toBe(1)
  })

  it('deduplicates terminal fingerprints', () => {
    const coordinator = new FailureCoordinator()

    const signal = {
      impact: 'application-fatal' as const,

      code: 'REPEATED_FATAL',

      userMessage: '应用无法继续。',

      cause: new Error('same'),

      scope: {
        kind: 'application' as const,
      },

      recovery: 'reload' as const,
    }

    coordinator.report(signal)
    coordinator.report(signal)

    expect(coordinator.getSnapshot().terminal?.additionalIncidentCount).toBe(0)
  })
})
