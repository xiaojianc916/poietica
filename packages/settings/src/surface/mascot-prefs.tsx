import { useSyncExternalStore } from 'react'
import { SettingsGroup, ToggleRow } from './settings-primitives'

/*
 * 吉祥物的两个开关（欢迎页那枚 iframe 的偏好）。
 *
 * 刻意不进 AppSettings：那张表与 src-tauri 的 AppSettings 逐字段镜像，Rust、
 * 默认值、迁移三处都要一起动，而这两项只属于渲染层的一枚 iframe。真相放在
 * localStorage —— 这里是唯一写入口，agent-ui 的 MascotBadge 只读。键名与
 * 事件名在 packages/agent-ui/src/surface/mascot.tsx 有一份逐字相同的副本，
 * 两处必须一起改。
 */

const PREF_TOUR = 'poietica.mascot.autoTour'
const PREF_FOLLOW = 'poietica.mascot.followPointer'
const PREFS_EVENT = 'poietica:mascot-prefs'

/* 键缺席即开启：默认自动巡演、默认跟随指针。 */
function readPref(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== '0'
  } catch {
    return true
  }
}

function writePref(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0')
  } catch {
    /* 写不进去只影响下次启动的初值，不值得打断设置页。 */
  }

  window.dispatchEvent(new Event(PREFS_EVENT))
}

function subscribe(onStoreChange: () => void): () => void {
  window.addEventListener(PREFS_EVENT, onStoreChange)

  return () => {
    window.removeEventListener(PREFS_EVENT, onStoreChange)
  }
}

function readTour(): boolean {
  return readPref(PREF_TOUR)
}

function readFollow(): boolean {
  return readPref(PREF_FOLLOW)
}

export function MascotPrefsGroup() {
  const tour = useSyncExternalStore(subscribe, readTour)
  const follow = useSyncExternalStore(subscribe, readFollow)

  return (
    <SettingsGroup title="吉祥物">
      <ToggleRow
        checked={tour}
        description="欢迎页的小家伙自动在各个场景之间巡演"
        label="自动巡演"
        onChange={(checked) => {
          writePref(PREF_TOUR, checked)
        }}
      />

      <ToggleRow
        checked={follow}
        description="小家伙的目光与身体跟随鼠标指针"
        label="跟随指针"
        onChange={(checked) => {
          writePref(PREF_FOLLOW, checked)
        }}
      />
    </SettingsGroup>
  )
}
