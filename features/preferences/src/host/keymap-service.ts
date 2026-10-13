import type { Logger } from '@poietica/foundation'
import { createJsonDocument, type JsonDocument } from '@poietica/fs-kit'
import { KeyOverrides } from '../contract/entities'

export type KeyOverridesValue = KeyOverrides

export interface KeymapService {
  load(): Promise<void>
  current(): KeyOverridesValue
  set(commandId: string, key: string | null): KeyOverridesValue
  reset(): KeyOverridesValue
  flush(): Promise<void>
}

/** 独立于 preferences.json 的 keymap.json；每次变化立即落盘。 */
export function createKeymapService(d: { file: string; logger: Logger }): KeymapService {
  const doc: JsonDocument<KeyOverridesValue> = createJsonDocument({
    file: d.file,
    schema: KeyOverrides,
    defaults: () => ({}),
    logger: d.logger,
  })
  return {
    async load() {
      await doc.load()
    },
    current: () => doc.current(),
    set(commandId, key) {
      void doc.save({ ...doc.current(), [commandId]: key })
      return doc.current()
    },
    reset() {
      void doc.save({})
      return doc.current()
    },
    async flush() {
      await doc.flush()
    },
  }
}
