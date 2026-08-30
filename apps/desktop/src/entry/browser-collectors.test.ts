import { describe, expect, it } from 'bun:test'
import { isBenignWindowError } from './browser-collectors'

describe('window error policy', () => {
  it.each([
    'ResizeObserver loop completed with undelivered notifications.',
    'ResizeObserver loop limit exceeded',
  ])('classifies the browser notification as benign: %s', (message) => {
    expect(
      isBenignWindowError({
        message,
        error: undefined,
      }),
    ).toBe(true)
  })

  it('reads the message from an Error instance', () => {
    expect(
      isBenignWindowError({
        message: '',
        error: new Error('ResizeObserver loop completed with undelivered notifications.'),
      }),
    ).toBe(true)
  })

  it('normalizes surrounding whitespace', () => {
    expect(
      isBenignWindowError({
        message: '  ResizeObserver loop limit exceeded  ',
        error: undefined,
      }),
    ).toBe(true)
  })

  it('does not ignore arbitrary ResizeObserver failures', () => {
    expect(
      isBenignWindowError({
        message: 'ResizeObserver callback crashed while updating the editor.',
        error: undefined,
      }),
    ).toBe(false)
  })

  it('does not ignore genuine application failures', () => {
    expect(
      isBenignWindowError({
        message: 'Cannot read properties of undefined',
        error: new TypeError('Cannot read properties of undefined'),
      }),
    ).toBe(false)
  })
})
