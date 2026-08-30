import { applyThemePreference } from '@poietica/design-system'
import { useEffect, useLayoutEffect, useState, useSyncExternalStore } from 'react'
import type { AppSettings } from '../settings'
import { createSettingsSession, type SettingsOperation } from '../settings-session'
import type { SettingsStore } from '../settings-store'

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
}

export function useSettingsController({
  open,
  store,
  onOpenChange,
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

  useLayoutEffect(() => {
    if (snapshot.settings) {
      applyThemePreference(snapshot.settings.theme)
    }
  }, [snapshot.settings])

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
