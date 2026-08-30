import { ToastRegion } from '@poietica/design-system'
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { noticeStore } from './notices'
/** 通知的唯一出口：store 说什么就画什么。 */
export function NoticeRegion() {
  const notices = useSyncExternalStore(
    noticeStore.subscribe,
    noticeStore.getSnapshot,
    noticeStore.getSnapshot,
  )
  useEffect(() => noticeStore.start(), [])
  /* 窗口没露面时不烧停留时间：回来才开始读。 */
  useEffect(() => {
    const sync = (): void => {
      noticeStore.setPaused('hidden', document.hidden)
    }
    sync()
    document.addEventListener('visibilitychange', sync)
    return () => {
      document.removeEventListener('visibilitychange', sync)
    }
  }, [])
  const handleHoverChange = useCallback((hovering: boolean) => {
    noticeStore.setPaused('hover', hovering)
  }, [])
  return (
    <ToastRegion
      notices={notices}
      onDismiss={noticeStore.dismiss}
      onHoverChange={handleHoverChange}
    />
  )
}
