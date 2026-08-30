import { describe, expect, it } from 'bun:test'
import { FailureCoordinator, type TerminalFailureIncident } from './coordinator'
import { createTerminalFailureViewModel } from './terminal-view-model'

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
