/**
 * Object shaping helpers for a workspace that runs with
 * `exactOptionalPropertyTypes: true`.
 *
 * Under that flag an optional property and a property explicitly set to
 * `undefined` are different types. Spreading the result of this helper is how
 * a caller says "this key may simply be absent" without widening the target
 * type to `| undefined`, which would defeat the flag.
 */

/**
 * Produces a single-entry object, or an empty one when the value is absent.
 *
 * @example
 * const shaped = {
 *   name,
 *   ...optionalProperty('stack', error.stack),
 * }
 */
export function optionalProperty<Key extends string, Value>(
  key: Key,
  value: Value | undefined,
): Partial<Record<Key, Value>> {
  if (value === undefined) {
    return {}
  }

  return {
    [key]: value,
  } as Record<Key, Value>
}
