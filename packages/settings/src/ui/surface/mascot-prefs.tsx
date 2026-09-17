import { createPreference } from '@poietica/external-store'
import { warn } from '@poietica/problem'
import { useSyncExternalStore } from 'react'
import { SettingsGroup, ToggleRow } from './settings-primitives'

/*
 * 吉祥物的两个开关。刻意不进 AppSettings：那张表与 src-tauri 的 AppSettings
 * 逐字段镜像，Rust、默认值、迁移三处都要一起动，而这两项只属于渲染层。
 */

const PREF_TOUR = 'poietica.mascot.autoTour'
const PREF_FOLLOW = 'poietica.mascot.followPointer'

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
        description="欢迎页的吉祥物自动在各个场景之间巡演"
        label="自动巡演"
        onChange={(value) => tourPreference.write(value)}
      />

      <ToggleRow
        checked={follow}
        description="吉祥物的目光与身体跟随鼠标指针"
        label="跟随指针"
        onChange={(value) => followPreference.write(value)}
      />
    </SettingsGroup>
  )
}
