import { Banner } from '@poietica/design-system'
import type { AppUpdateStore } from '@poietica/update'
import { LoaderCircle } from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { advance, updateNotice } from './update-phase'

interface UpdateBannerProps {
  readonly store: AppUpdateStore
}

/*
 * 更新这件事从「发现」到「装上」全程住在这里：发现新版本就自动下载，下载中与待重启
 * 的横幅**停在那儿不自己走**（`persistent` → Banner 的 `holdMs: null`），只有「已是最新」
 * 这一句说完自己消失。
 *
 * 常驻与自动消失的分界不是时间长短，是**有没有未了的事**：下载中的人想知道下到哪了，
 * 待重启那一句带着唯一的安装入口 —— 它淡出等于把入口一起收走。所以这里报的是
 * `holdMs: null`（连计时器都不装），不是「一个够长的毫秒数」—— 后者只是把同一个错误推迟。
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
      /*
       * 左边那枚字形。有语气的那两档（已是最新、待重启）由 tone 自己画绿勾，这里给的字形
       * 会被忽略 —— 所以只有下载中这一档需要它：一枚**转着**的箭头，与「正在下载」同义。
       * 不转的话，一条停住的横幅配一个静止字形读起来是「卡住了」，正好相反。
       */
      {...(notice.tone === undefined
        ? { icon: <LoaderCircle className="size-4 animate-spin" /> }
        : {})}
      /* 常驻：没有计时器，也没有淡出，收场由相位离开时这个组件卸载决定。 */
      {...(notice.persistent === true ? { holdMs: null } : {})}
      {...(notice.progress === undefined ? {} : { progress: notice.progress })}
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
      /* 非持久那一档（已是最新）说完自己走；常驻那一档根本没有计时器，不会走到这里。 */
      onDone={() => {
        setDismissed(notice.key)
      }}
    />
  )
}
