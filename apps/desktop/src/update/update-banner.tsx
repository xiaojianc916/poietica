import { Banner } from '@poietica/design-system'
import type { AppUpdateStore } from '@poietica/update'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { advance, updateNotice } from './update-phase'

interface UpdateBannerProps {
  readonly store: AppUpdateStore
}

/*
 * 更新这件事从「发现」到「装上」全程住在这里：发现新版本就自动下载，下载中与待重启
 * 的横幅**停在那儿不自己走**（`persistent`），只有「已是最新」这一句说完自己消失。
 *
 * 常驻与自动消失的分界不是时间长短，是**有没有未了的事**：下载中的人想知道下到哪了，
 * 待重启那一句带着唯一的安装入口 —— 它淡出等于把入口一起收走。`holdMs` 因此由
 * `persistent` 决定，不给它第二套计时。
 *
 * 常驻横幅在相位走开（重启后进程被接管、下载失败退回 idle）时自然卸载，不需要
 * `dismissed`：那条路只在「同一相位里说完了自己走」时才需要。
 */
export function UpdateBanner({ store }: UpdateBannerProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const notice = updateNotice(state)
  const [dismissed, setDismissed] = useState<string | null>(null)

  useEffect(() => {
    if (notice === null) {
      setDismissed(null)
    }
  }, [notice])

  if (notice === null || notice.key === dismissed) {
    return null
  }

  return (
    <Banner
      key={notice.key}
      onDone={() => {
        setDismissed(notice.key)
      }}
      text={notice.text}
      {...(notice.action === undefined
        ? {}
        : {
            actions: [
              {
                label: notice.action,
                onClick: () => {
                  advance(state, store)
                },
              },
            ],
          })}
      {...(notice.tone === undefined ? {} : { tone: notice.tone })}
      /*
       * 常驻：把停留时长拉到比人可能停留的时间还长。`Banner` 的收场是
       * `holdMs + FADE_MS` 之后回调 `onDone`，所以「不走」= 报一个够长的数；
       * 相位一换这个组件就整条换掉，不必自己去清定时器。
       */
      {...(notice.persistent === true ? { holdMs: PERSISTENT_HOLD_MS } : {})}
    />
  )
}

/**
 * 常驻横幅的停留时长：一小时。够到「下载完 + 人去泡杯咖啡」这类停留，又仍然是有限
 * 数（`Banner` 只认毫秒数，没有「永久」这一档）。
 *
 * 下载中每跳一个百分点都会重渲，但键是 `downloading:<版本>`，重渲不重挂，计时不重置。
 */
const PERSISTENT_HOLD_MS = 60 * 60 * 1000
