import type { Event } from '@poietica/foundation'

export interface NotificationPort {
  on(event: 'click', listener: () => void): unknown
  show(): void
}

export interface DialogPort {
  showOpenDialog(
    win: unknown,
    o: { properties: string[]; title?: string; filters?: readonly { name: string; extensions: readonly string[] }[] },
  ): Promise<{ canceled: boolean; filePaths: string[] }>
  showSaveDialog(
    win: unknown,
    o: { defaultPath?: string; filters?: readonly { name: string; extensions: readonly string[] }[] },
  ): Promise<{ canceled: boolean; filePath?: string }>
}

export interface LoggerPort {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  child(bindings: Record<string, unknown>): LoggerPort
}

export type { Event }
