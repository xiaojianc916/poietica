/* 包的公开面。显式罗列而不是 export *：谁在用什么必须一眼可见。 */

export { createExternalStore, type ExternalStore, type ExternalStoreSource } from './external-store'
export {
  createPreference,
  type Preference,
  type PreferenceFailure,
  type PreferenceSource,
} from './preference'
