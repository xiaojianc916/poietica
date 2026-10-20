import { Banner } from '@poietica/design-system'
import { useKernel, useObservable } from '@poietica/ui-kernel'
import { Info, TriangleAlert } from 'lucide-react'
import type { ReactElement } from 'react'

/**
 * 内核通知的唯一落点：屏幕顶部居中的 design-system Banner。
 *
 * 同一时刻只画一条 —— 服务里也只留最新的一条。退场由 Banner 自己计时，淡完回调 dismiss；
 * 外壳不再持有卡片队列，也不再有右下角的 toast 区域。
 */
export function Banners(): ReactElement | null {
  const { kernelServices } = useKernel()
  const banners = useObservable(kernelServices.banners)
  const notice = banners[0]
  if (notice === undefined) return null

  return (
    <Banner
      {...(notice.action === undefined
        ? {}
        : {
            actions: [
              {
                label: notice.action.label,
                onClick: () => {
                  kernelServices.banners.dismiss(notice.id)
                  notice.action?.run()
                },
              },
            ],
          })}
      {...(notice.severity === 'success' || notice.severity === 'error' ? { tone: notice.severity } : {})}
      holdMs={notice.holdMs}
      icon={notice.severity === 'warning' ? <TriangleAlert className="size-4" /> : <Info className="size-4" />}
      key={notice.id}
      onDone={() => {
        kernelServices.banners.dismiss(notice.id)
      }}
      text={notice.detail === undefined ? notice.title : `${notice.title}：${notice.detail}`}
    />
  )
}
