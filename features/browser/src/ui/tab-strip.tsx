import { Globe, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { BrowserTab } from '../contract'

/* 标签条里那一格「脸」：装载中转圈、有站点图标就画它、取不回来退回地球。标签条本身（排版、悬浮换脸、Delete / 方向键）由 workbench 的右坞按 dockTabs 统一绘制。 */
export function BrowserTabIcon({ tab }: { readonly tab: BrowserTab }) {
  /** 取不回来的图标退回地球：裂图同样是「没有图标」，却更难看。 */
  const [broken, setBroken] = useState<string | null>(null)

  if (tab.loading) {
    return <LoaderCircle aria-hidden className="animate-spin" />
  }

  if (tab.favicon === null || tab.favicon === broken) {
    return <Globe aria-hidden />
  }

  return (
    <img
      alt=""
      className=" rounded-sm"
      onError={() => {
        setBroken(tab.favicon)
      }}
      src={tab.favicon}
    />
  )
}
