import { createPreference } from '@poietica/design-system'
import { warn } from '@poietica/problem'
import { useSyncExternalStore } from 'react'
import { SettingsGroup, ToggleRow } from './settings-primitives'

/*
 * 吉祥物的两个开关。
 *
 * 刻意不进 AppSettings：那张表与 src-tauri 的 AppSettings 逐字段镜像，Rust、
 * 默认值、迁移三处都要一起动，而这两项只属于渲染层的一个组件。
 *
 * 两项设置统一通过 @poietica/design-system 的 createPreference 读写。写入完成后只发送
 * 当前布尔快照，让同窗口内已经挂载的吉祥物立即采用；跳窗口变化由 Preference
 * 自己订阅。
 */

const PREF_TOUR = 'poietica.mascot.autoTour'
const PREF_FOLLOW = 'poietica.mascot.followPointer'
const PREFS_EVENT = 'poietica:mascot-prefs'

interface MascotPreferenceSnapshot {
  readonly tour: boolean
  readonly follow: boolean
}

const FAILURE_MESSAGES = {
  read: '读不出吉祥物偏好，使用默认值',
  write: '写不进吉祥物偏好，下次启动使用默认值',
}

function booleanPreference(key: string) {
  return createPreference<boolean>({
    key,
    fallback: true,
    decode: (raw) => raw !== '0',
    encode: (value) => (value ? '1' : '0'),
    onFailure: ({ stage, cause }) => {
      warn(FAILURE_MESSAGES[stage], { scope: 'mascot-preferences', cause })
    },
  })
}

const tourPreference = booleanPreference(PREF_TOUR)
const followPreference = booleanPreference(PREF_FOLLOW)

function publishPreferences(): void {
  const detail: MascotPreferenceSnapshot = {
    tour: tourPreference.read(),
    follow: followPreference.read(),
  }

  window.dispatchEvent(
    new CustomEvent<MascotPreferenceSnapshot>(PREFS_EVENT, {
      detail,
    }),
  )
}

function writeTour(value: boolean): void {
  tourPreference.write(value)
  publishPreferences()
}

function writeFollow(value: boolean): void {
  followPreference.write(value)
  publishPreferences()
}

export function MascotPrefsGroup() {
  const tour = useSyncExternalStore(
    tourPreference.subscribe,
    tourPreference.read,
    tourPreference.readFallback,
  )
  const follow = useSyncExternalStore(
    followPreference.subscribe,
    followPreference.read,
    followPreference.readFallback,
  )

  return (
    <SettingsGroup title="吉祥物">
      <ToggleRow
        checked={tour}
        description="欢迎页的小家伙自动在各个场景之间巡演"
        label="自动巡演"
        onChange={writeTour}
      />

      <ToggleRow
        checked={follow}
        description="小家伙的目光与身体跟随鼠标指针"
        label="跟随指针"
        onChange={writeFollow}
      />
    </SettingsGroup>
  )
}
