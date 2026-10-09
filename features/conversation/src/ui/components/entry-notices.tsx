import { builtinPoints, type EntryNoticeItem, useContributions } from '@poietica/ui-kernel'
import type { ReactElement, ReactNode } from 'react'
import './entry-notices.css'

/*
 * 入口提示的宿主：把 builtinPoints.entryNotices 上的贡献画成一列，交给新对话界面。
 *
 * 与外壳的 OverlayHost（workbench 的 parts/overlays.tsx）同一形制：useVisible 是个 Hook，
 * 只能在组件里调，所以每条贡献包一层。外壳那一份住在 workbench，这一份住在 conversation，
 * 因为落点是入口版心而不是浮层。
 */

function NoticeHost({ item }: { readonly item: EntryNoticeItem }): ReactNode {
  const visible = item.useVisible()
  if (!visible) return null
  const Component = item.component
  return (
    <div className="entry-notice" data-entry-notice={item.id} role="status">
      <Component />
    </div>
  )
}

export function EntryNotices(): ReactElement | null {
  const items = useContributions(builtinPoints.entryNotices)
  if (items.length === 0) return null
  return (
    <div className="entry-notices">
      {items.map(({ item }) => (
        <NoticeHost item={item} key={item.id} />
      ))}
    </div>
  )
}
