import { createPreference, warn } from '@poietica/core'
import * as v from 'valibot'

/*
 * 名单是什么时候取回来的，落在盘上。
 *
 * 它只回答「算不算从来没取过」（shouldFetchOnOpen 的判据），从不参与任何判定：装了
 * 什么永远由账本说了算，会话里能调用什么永远由 agent 报给那条会话。
 */

const SNAPSHOT_FORMAT = 3

const SNAPSHOT_KEY = 'poietica.extensions.snapshot'

export interface ExtensionSnapshot {
  readonly format: number
  readonly catalogFetchedAt: string
}

export const EMPTY_SNAPSHOT: ExtensionSnapshot = {
  format: SNAPSHOT_FORMAT,
  catalogFetchedAt: '',
}

/*
 * 校验交给 valibot，与清单解码同一条管线：这份文档是上一个版本的程序写下的，字段可以
 * 少、类型可以变，而它长得像合法 JSON。
 */
const Document = v.object({
  format: v.literal(SNAPSHOT_FORMAT),
  catalogFetchedAt: v.string(),
})

export interface SnapshotCache {
  readonly read: () => ExtensionSnapshot
  readonly write: (catalogFetchedAt: string) => void
}

export function createSnapshotCache(): SnapshotCache {
  const preference = createPreference<ExtensionSnapshot>({
    key: SNAPSHOT_KEY,
    fallback: EMPTY_SNAPSHOT,
    /* 解码不许抛：这条管线由第一帧同步调用。坏文档回落到空快照。 */
    decode: (raw) => {
      try {
        const parsed = v.safeParse(Document, JSON.parse(raw))

        return parsed.success ? parsed.output : EMPTY_SNAPSHOT
      } catch {
        return EMPTY_SNAPSHOT
      }
    },
    /* 空快照写成 null：那是「没有快照」，不是「快照说这里什么都没有」。 */
    encode: (value) => (value.catalogFetchedAt === '' ? null : JSON.stringify(value)),
    onFailure: (failure) => {
      warn('扩展快照没能存下来，下次打开要重新取名单', { scope: 'plugins', ...failure })
    },
  })

  return {
    read: () => preference.read(),

    write(catalogFetchedAt) {
      if (preference.read().catalogFetchedAt === catalogFetchedAt) {
        return
      }

      preference.write({ format: SNAPSHOT_FORMAT, catalogFetchedAt })
    },
  }
}
