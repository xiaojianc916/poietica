import { builtinPoints, type EntryNoticeItem, useContributions } from '@poietica/ui-kernel'
import type { ReactElement, ReactNode } from 'react'
import './entry-notices.css'

/* useVisible 是 Hook，只能在组件里调，所以每条贡献包一层；这份宿主住在 conversation 而非 workbench，因为落点是入口版心而不是浮层。 */

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
