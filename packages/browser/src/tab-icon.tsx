import { Globe, LoaderCircle } from 'lucide-react'

import type { BrowserTab } from './browser-port'

/* 标签的脸：装载中转圈，有站点图标就画它，否则地球。标签条与标签下拉共用这一份。 */
export function TabIcon({ tab }: { readonly tab: BrowserTab }) {
  if (tab.loading) {
    return <LoaderCircle aria-hidden className="size-3.5 shrink-0 animate-spin opacity-60" />
  }

  if (tab.favicon === null) {
    return <Globe aria-hidden className="size-3.5 shrink-0 opacity-60" />
  }

  return <img alt="" className="size-3.5 shrink-0 rounded-sm" src={tab.favicon} />
}
