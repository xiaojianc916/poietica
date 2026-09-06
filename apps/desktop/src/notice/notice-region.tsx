import { ToastRegion } from '@poietica/design-system'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { NoticeStore } from './notices'

export function NoticeRegion({ store }: { readonly store: NoticeStore }) {
  const notices = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useEffect(() => {
    const sync = (): void => {
      store.setPaused('hidden', document.hidden)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
    }
  }, [store])
  const handleHoverChange = useCallback(
    (hovering: boolean) => {
      store.setPaused('hover', hovering)
    },
    [store],
  )
  return (
    <ToastRegion notices={notices} onDismiss={store.dismiss} onHoverChange={handleHoverChange} />
  )
}
