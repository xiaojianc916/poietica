import { Globe, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import type { BrowserTab } from '../contract'

/*
 * 标签条里那一格「脸」。**迁移自** legacy `packages/workspace/src/panels/auxiliary-tab-strip.tsx`
 * 的 BrowserTabIcon：装载中转圈、有站点图标就画它、取不回来退回地球。
 *
 * 标签条本身（标签的排版、悬浮换脸、Delete / 方向键）由 workbench 的右坞统一绘制 ——
 * legacy 里浏览器标签与其它通道的标签**同处一条标签条**，新架构里那一条是 `panels` 贡献
 * 的 `dockTabs` 组（见 packages/workbench/src/parts/auxiliary-dock.tsx）。本文件只留这张脸，
 * 供 dockTabs.tabs() 组装每一格。
 */
export function BrowserTabIcon({ tab }: { readonly tab: BrowserTab }) {
  /* 取不回来的图标退回地球：一行裂图比没有图标更难看，而它同样是「没有图标」。 */
  const [broken, setBroken] = useState<string | null>(null)

  if (tab.loading) {
    return <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin opacity-60" />
  }

  if (tab.favicon === null || tab.favicon === broken) {
    return <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />
  }

  return (
    <img
      alt=""
      className="size-3.5 shrink-0 rounded-sm"
      onError={() => {
        setBroken(tab.favicon)
      }}
      src={tab.favicon}
    />
  )
}

/*
 * 标签条本身已由右坞统一绘制（09 页 §4 的 `panels` + 本贡献的 `dockTabs`）：legacy 的
 * auxiliary-panel 里浏览器标签与其它通道的标签**同处一条标签条**，新架构里那一条归
 * workbench（packages/workbench/src/parts/auxiliary-dock.tsx），本文件只留「标签的脸」
 * （BrowserTabIcon，供 dockTabs.tabs() 组装每一格）。
 */
