export interface NotificationPort {
  on(event: 'click', listener: () => void): unknown
  show(): void
}
