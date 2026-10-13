import type { NotificationPort } from './ports'

export interface NotifyService {
  show(o: { title: string; body: string; threadId?: string }): void
}

export function createNotifyService(d: {
  isMainFocused(): boolean
  focusMain(): void
  createNotification(o: { title: string; body: string; silent?: boolean }): NotificationPort
  emitClicked(threadId: string | null): void
}): NotifyService {
  return {
    show(o) {
      if (d.isMainFocused()) return
      const notification = d.createNotification({ title: o.title, body: o.body, silent: false })
      notification.on('click', () => {
        d.focusMain()
        d.emitClicked(o.threadId ?? null)
      })
      notification.show()
    },
  }
}
