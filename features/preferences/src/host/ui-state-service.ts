import type { Logger } from '@poietica/foundation'
import { createJsonDocument, type JsonDocument } from '@poietica/fs-kit'
import { UiState, type UiStateKey } from '../contract/entities'

export type { UiState } from '../contract/entities'

export interface UiStateService {
  load(): Promise<void>
  get(key: UiStateKey): unknown
  set(key: UiStateKey, value: unknown): void
  flush(): Promise<void>
}

/** 走 createJsonDocument 的 saveDebounced（500ms）；load 前先给默认空表，退出时 flush 立即落盘。 */
export function createUiStateService(d: { file: string; logger: Logger; debounceMs?: number }): UiStateService {
  const doc: JsonDocument<UiState> = createJsonDocument({
    file: d.file,
    schema: UiState,
    defaults: () => ({}),
    logger: d.logger,
    ...(d.debounceMs === undefined ? {} : { debounceMs: d.debounceMs }),
  })

  return {
    async load() {
      await doc.load()
    },
    get: (key) => doc.current()[key] ?? null,
    set(key, value) {
      doc.saveDebounced({ ...doc.current(), [key]: value })
    },
    async flush() {
      await doc.flush()
    },
  }
}
