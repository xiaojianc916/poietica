import {
  type AppSettings,
  createSettingsSession,
  type SettingsOperation,
  type SettingsStore,
} from '@poietica/settings'
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'

export type { SettingsOperation }

export interface SettingsController {
  readonly settings: AppSettings | undefined
  readonly loading: boolean
  readonly saving: boolean
  readonly operation: SettingsOperation | undefined
  readonly error: string | undefined
  readonly update: (updater: (settings: AppSettings) => AppSettings) => void
  readonly reset: () => void
  readonly retry: () => void
  readonly requestClose: () => void
}

interface UseSettingsControllerOptions {
  readonly open: boolean
  readonly store: SettingsStore
  readonly onOpenChange: (open: boolean) => void
  readonly onThemeChange: (theme: AppSettings['theme']) => void
}

export function useSettingsController({
  open,
  store,
  onOpenChange,
  onThemeChange,
}: UseSettingsControllerOptions): SettingsController {
  const [session] = useState(() =>
    createSettingsSession({
      store,
      schedule: (task, delayMs) => {
        const timeout = window.setTimeout(task, delayMs)

        return () => {
          window.clearTimeout(timeout)
        }
      },
    }),
  )

  useEffect(() => {
    if (!open) {
      return undefined
    }

    return session.start()
  }, [open, session])

  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot)

  const theme = snapshot.settings?.theme

  useLayoutEffect(() => {
    if (theme !== undefined) {
      onThemeChange(theme)
    }
  }, [onThemeChange, theme])

  useEffect(() => {
    if (snapshot.status === 'closed') {
      onOpenChange(false)
    }
  }, [onOpenChange, snapshot.status])

  return {
    settings: snapshot.settings,
    loading: snapshot.status === 'idle' || snapshot.status === 'loading',
    saving: snapshot.status === 'saving',
    operation: snapshot.operation,
    error: snapshot.error,
    update: session.update,
    reset: session.reset,
    retry: session.retry,
    requestClose: session.requestClose,
  }
}
