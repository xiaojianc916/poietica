import { createExternalStore } from '@poietica/external-store'
import type { AppSettings } from './settings'
import type { SettingsStore } from './settings-store'

export type SettingsOperation = 'load' | 'save' | 'reset'

interface SettingsSessionSnapshot {
  readonly status: 'idle' | 'loading' | 'ready' | 'saving' | 'error' | 'closed'
  readonly settings?: AppSettings
  readonly operation?: SettingsOperation
  readonly error?: string
}

interface SettingsSessionScheduler {
  readonly schedule: (task: () => void, delayMs: number) => () => void
}

interface SettingsSessionOptions extends SettingsSessionScheduler {
  readonly store: SettingsStore
}

interface SettingsSession {
  readonly getSnapshot: () => SettingsSessionSnapshot
  readonly subscribe: (listener: () => void) => () => void
  readonly start: () => () => void
  readonly update: (updater: (settings: AppSettings) => AppSettings) => void
  readonly reset: () => void
  readonly retry: () => void
  readonly requestClose: () => void
}

const AUTO_SAVE_DELAY_MS = 350
const LOAD_TIMEOUT_MS = 5_000

const IDLE: SettingsSessionSnapshot = {
  status: 'idle',
}

export function createSettingsSession(options: SettingsSessionOptions): SettingsSession {
  let snapshot: SettingsSessionSnapshot = IDLE
  let draft: AppSettings | null = null
  let persisted: AppSettings | null = null
  let active = false
  let lifecycle = 0
  let loadVersion = 0
  let saveInFlight = false
  let resetInFlight = false
  let saveQueued = false
  let closeRequested = false
  let cancelScheduledSave: (() => void) | null = null
  let cancelScheduledLoadTimeout: (() => void) | null = null
  let resetUpdaters: Array<(settings: AppSettings) => AppSettings> = []

  const external = createExternalStore<SettingsSessionSnapshot>({
    read: () => snapshot,
  })

  const publish = (
    status: SettingsSessionSnapshot['status'],
    operation?: SettingsOperation,
    error?: string,
  ): void => {
    snapshot = {
      status,
      ...(draft === null ? {} : { settings: draft }),
      ...(operation === undefined ? {} : { operation }),
      ...(error === undefined ? {} : { error }),
    }

    external.notify()
  }

  const publishWorkingState = (): void => {
    if (resetInFlight) {
      publish('saving', 'reset')
      return
    }

    if (saveInFlight) {
      publish('saving', 'save')
      return
    }

    publish('ready')
  }

  const cancelSaveTimer = (): void => {
    cancelScheduledSave?.()
    cancelScheduledSave = null
  }

  const cancelLoadTimeout = (): void => {
    cancelScheduledLoadTimeout?.()
    cancelScheduledLoadTimeout = null
  }

  const finishClose = (): void => {
    cancelSaveTimer()
    cancelLoadTimeout()

    active = false
    lifecycle += 1
    loadVersion += 1
    saveInFlight = false
    resetInFlight = false
    saveQueued = false
    closeRequested = false
    resetUpdaters = []
    draft = null
    persisted = null

    publish('closed')
  }

  const scheduleSave = (): void => {
    cancelSaveTimer()

    cancelScheduledSave = options.schedule(() => {
      cancelScheduledSave = null
      flushSave()
    }, AUTO_SAVE_DELAY_MS)
  }

  const flushSave = (): void => {
    cancelSaveTimer()

    if (!active || draft === null || persisted === null) {
      return
    }

    if (saveInFlight || resetInFlight) {
      saveQueued = true
      return
    }

    if (settingsEqual(draft, persisted)) {
      saveQueued = false

      if (closeRequested) {
        finishClose()
      } else {
        publish('ready')
      }

      return
    }

    const lifecycleAtStart = lifecycle
    const submitted = draft

    saveInFlight = true
    saveQueued = false

    publish('saving', 'save')

    void options.store.save(submitted).then(
      () => {
        if (!active || lifecycle !== lifecycleAtStart) {
          return
        }

        saveInFlight = false
        persisted = submitted

        const currentDraft = draft

        if (currentDraft === null) {
          return
        }

        if (!settingsEqual(currentDraft, submitted)) {
          publish('ready')

          if (closeRequested || saveQueued) {
            flushSave()
          } else if (cancelScheduledSave === null) {
            scheduleSave()
          }

          return
        }

        saveQueued = false

        if (closeRequested) {
          finishClose()
        } else {
          publish('ready')
        }
      },
      (cause: unknown) => {
        if (!active || lifecycle !== lifecycleAtStart) {
          return
        }

        saveInFlight = false

        publish('error', 'save', getErrorMessage(cause))
      },
    )
  }

  const beginLoad = (): void => {
    cancelSaveTimer()
    cancelLoadTimeout()

    const cached = options.store.getSnapshot()

    if (cached !== undefined) {
      draft = cached
      persisted = cached
      publish('ready')
      return
    }

    const lifecycleAtStart = lifecycle
    const request = loadVersion + 1

    loadVersion = request
    draft = null
    persisted = null

    publish('loading', 'load')

    cancelScheduledLoadTimeout = options.schedule(() => {
      cancelScheduledLoadTimeout = null

      if (!active || lifecycle !== lifecycleAtStart || loadVersion !== request) {
        return
      }

      loadVersion += 1
      publish('error', 'load', '设置加载超时，请重试。')
    }, LOAD_TIMEOUT_MS)

    void options.store.load().then(
      (settings) => {
        if (!active || lifecycle !== lifecycleAtStart || loadVersion !== request) {
          return
        }

        cancelLoadTimeout()
        draft = settings
        persisted = settings

        publish('ready')
      },
      (cause: unknown) => {
        if (!active || lifecycle !== lifecycleAtStart || loadVersion !== request) {
          return
        }

        cancelLoadTimeout()
        publish('error', 'load', getErrorMessage(cause))
      },
    )
  }

  const update = (updater: (settings: AppSettings) => AppSettings): void => {
    if (!active || draft === null) {
      return
    }

    const next = updater(draft)

    if (settingsEqual(next, draft)) {
      return
    }

    draft = next

    if (resetInFlight) {
      resetUpdaters.push(updater)
    }

    publishWorkingState()
    scheduleSave()
  }

  const reset = (): void => {
    if (!active || draft === null || saveInFlight || resetInFlight) {
      return
    }

    cancelSaveTimer()

    saveQueued = false
    resetUpdaters = []
    resetInFlight = true

    const lifecycleAtStart = lifecycle

    publish('saving', 'reset')

    void options.store.reset().then(
      (settings) => {
        if (!active || lifecycle !== lifecycleAtStart) {
          return
        }

        const nextDraft = resetUpdaters.reduce((current, updater) => updater(current), settings)

        resetInFlight = false
        persisted = settings
        draft = nextDraft
        resetUpdaters = []

        if (!settingsEqual(nextDraft, settings)) {
          publish('ready')

          if (closeRequested || saveQueued) {
            flushSave()
          } else if (cancelScheduledSave === null) {
            scheduleSave()
          }

          return
        }

        saveQueued = false

        if (closeRequested) {
          finishClose()
        } else {
          publish('ready')
        }
      },
      (cause: unknown) => {
        if (!active || lifecycle !== lifecycleAtStart) {
          return
        }

        resetInFlight = false
        resetUpdaters = []

        publish('error', 'reset', getErrorMessage(cause))
      },
    )
  }

  const retry = (): void => {
    if (!active || snapshot.status !== 'error') {
      return
    }

    if (snapshot.operation === 'load') {
      beginLoad()
      return
    }

    if (snapshot.operation === 'reset') {
      reset()
      return
    }

    flushSave()
  }

  const requestClose = (): void => {
    if (!active) {
      return
    }

    closeRequested = true

    cancelSaveTimer()

    if (draft === null || persisted === null) {
      finishClose()
      return
    }

    flushSave()
  }

  const start = (): (() => void) => {
    if (active) {
      throw new Error('Settings session is already active.')
    }

    active = true
    lifecycle += 1
    closeRequested = false
    saveQueued = false
    saveInFlight = false
    resetInFlight = false
    resetUpdaters = []

    beginLoad()

    const startedLifecycle = lifecycle

    return () => {
      if (!active || lifecycle !== startedLifecycle) {
        return
      }

      active = false
      lifecycle += 1
      loadVersion += 1

      cancelSaveTimer()
      cancelLoadTimeout()

      closeRequested = false
      saveQueued = false
      saveInFlight = false
      resetInFlight = false
      resetUpdaters = []
      draft = null
      persisted = null

      publish('idle')
    }
  }

  return {
    getSnapshot: external.read,
    subscribe: external.subscribe,
    start,
    update,
    reset,
    retry,
    requestClose,
  }
}

function settingsEqual(left: AppSettings, right: AppSettings): boolean {
  return valuesEqual(left, right)
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }

  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false
  }

  const leftRecord = left as Readonly<Record<string, unknown>>

  const rightRecord = right as Readonly<Record<string, unknown>>

  const leftKeys = Object.keys(leftRecord)
  const rightKeys = Object.keys(rightRecord)

  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) => Object.hasOwn(rightRecord, key) && valuesEqual(leftRecord[key], rightRecord[key]),
    )
  )
}

function getErrorMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.trim().length > 0) {
    return cause.message
  }

  return '设置操作失败，请重试。'
}
