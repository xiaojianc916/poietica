import { defineServiceToken } from '@poietica/foundation'
import type { Preferences, PreferencesPatch } from '../contract'

/**
 * 其它功能读偏好用这个令牌（conversation 读 general/appearance，update 读 updates.autoCheck）。
 * 写偏好一律走契约方法，不经这个令牌。
 */
export interface PreferencesApi {
  current(): Preferences
  subscribe(listener: (p: Preferences) => void): () => void
  update(patch: PreferencesPatch): Promise<void>
}

export const PreferencesToken = defineServiceToken<PreferencesApi>('preferences', 'Preferences')
