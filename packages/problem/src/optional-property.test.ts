import { describe, expect, it } from 'bun:test'
import { optionalProperty } from './optional-property'

describe('optionalProperty', () => {
  it('omits the key when the value is absent', () => {
    expect(optionalProperty('stack', undefined)).toEqual({})
    expect(Object.hasOwn(optionalProperty('stack', undefined), 'stack')).toBe(false)
  })

  it('keeps values that are falsy but present', () => {
    expect(optionalProperty('line', 0)).toEqual({ line: 0 })
    expect(optionalProperty('label', '')).toEqual({ label: '' })
    expect(optionalProperty('cause', null)).toEqual({ cause: null })
  })
})
