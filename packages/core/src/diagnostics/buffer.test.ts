import { beforeEach, describe, expect, it } from 'bun:test'
import {
  clearDiagnosticLogs,
  configureDiagnosticBuffer,
  formatDiagnosticLogs,
  getRecentLogEntries,
  recordDiagnosticLog,
} from './buffer'

describe('diagnostic buffer', () => {
  beforeEach(() => {
    clearDiagnosticLogs()
    configureDiagnosticBuffer({
      capacity: 200,
    })
  })

  it('records structured log entries', () => {
    recordDiagnosticLog(
      'error',
      'settings save failed',
      {
        scope: 'workspace',
        operation: 'save',
      },
      '2026-07-24T00:00:00.000Z',
    )

    expect(getRecentLogEntries()).toEqual([
      expect.objectContaining({
        level: 'error',
        message: 'settings save failed',
        scope: 'workspace',
        timestamp: '2026-07-24T00:00:00.000Z',
        context: {
          operation: 'save',
        },
      }),
    ])
  })

  it('keeps only the newest bounded entries', () => {
    configureDiagnosticBuffer({
      capacity: 2,
    })

    recordDiagnosticLog('info', 'one', {}, new Date().toISOString())

    recordDiagnosticLog('info', 'two', {}, new Date().toISOString())

    recordDiagnosticLog('info', 'three', {}, new Date().toISOString())

    expect(getRecentLogEntries().map((entry) => entry.message)).toEqual(['two', 'three'])
  })

  it('redacts sensitive keys and bearer tokens', () => {
    recordDiagnosticLog(
      'error',
      'request failed',
      {
        accessToken: 'private-token',
        authorization: 'Bearer very-private-token',
        endpoint: 'https://user:password@example.com',
      },
      new Date().toISOString(),
    )

    const [entry] = getRecentLogEntries()

    expect(entry?.context['accessToken']).toBe('[REDACTED]')

    expect(entry?.context['authorization']).toBe('[REDACTED]')

    expect(entry?.context['endpoint']).not.toContain('password')
  })

  it('serializes Error and circular values safely', () => {
    const circular: {
      self?: unknown
    } = {}

    circular.self = circular

    recordDiagnosticLog(
      'error',
      'unexpected failure',
      {
        cause: new Error('broken'),
        circular,
      },
      new Date().toISOString(),
    )

    const [entry] = getRecentLogEntries()

    expect(entry?.context['cause']).toContain('broken')

    expect(entry?.context['circular']).toContain('[Circular]')
  })

  it('returns cloned immutable snapshots', () => {
    recordDiagnosticLog(
      'info',
      'snapshot',
      {
        operation: 'test',
      },
      new Date().toISOString(),
    )

    const first = getRecentLogEntries()
    const second = getRecentLogEntries()

    expect(first).not.toBe(second)
    expect(first[0]?.context).not.toBe(second[0]?.context)
  })

  it('formats readable diagnostic output', () => {
    recordDiagnosticLog(
      'warn',
      'retrying operation',
      {
        scope: 'document',
        attempt: 2,
      },
      '2026-07-24T00:00:00.000Z',
    )

    const formatted = formatDiagnosticLogs(getRecentLogEntries())

    expect(formatted).toContain('2026-07-24T00:00:00.000Z WARN [document]')

    expect(formatted).toContain('attempt: 2')
  })
})
