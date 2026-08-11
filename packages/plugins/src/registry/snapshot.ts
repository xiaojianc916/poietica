import type { PaletteEntry } from '@poietica/agent-contract'
import { createPreference, warn } from '@poietica/core'
import * as v from 'valibot'

/*
 * 上一次探测到的命令表，落在盘上。
 *
 * 只存这一样东西。账本与 mcp.json 一趟本地读就回来了，把它们也塞进快照等于造出第二份
 * 降级的真相；真正会长时间为空的是命令表 —— 它由 agent 在会话建立后报来，会话没建之前
 * 那一格恒空，人看到的是「我的技能全没了」。
 *
 * 形状对标 opencode 的 plugin-meta.json：一份带格式版本与指纹的记录，指纹没变就不写盘。
 * 指纹不是优化，是判据 —— 没有它就只能每次全量重写，而写盘本身会拖住第一帧。
 *
 * 快照只回答「真相到达之前先画什么」，从不参与任何判定。
 */

const SNAPSHOT_FORMAT = 1

const SNAPSHOT_KEY = 'poietica.extensions.snapshot'

export interface ExtensionSnapshot {
  readonly format: number
  /** 探测完成的时刻。界面上「上次检测」显示的就是它。 */
  readonly detectedAt: string
  /** 名单是什么时候取回来的。真相未到时，这一格替 marketplace 说话。 */
  readonly catalogFetchedAt: string
  readonly fingerprint: string
  readonly palette: readonly PaletteEntry[]
}

export const EMPTY_SNAPSHOT: ExtensionSnapshot = {
  format: SNAPSHOT_FORMAT,
  detectedAt: '',
  catalogFetchedAt: '',
  fingerprint: '',
  palette: [],
}

/*
 * 校验交给 valibot，与清单解码同一条管线。手写一遍字段检查会漏掉这份文档最危险的那一格：
 * 它是上一个版本的程序写下的，字段可以少、类型可以变，而它长得像合法 JSON。
 */
const Entry = v.object({
  kind: v.picklist(['builtin', 'command', 'skill']),
  name: v.string(),
  label: v.string(),
  description: v.string(),
})

const Document = v.object({
  format: v.literal(SNAPSHOT_FORMAT),
  detectedAt: v.string(),
  catalogFetchedAt: v.string(),
  fingerprint: v.string(),
  palette: v.array(Entry),
})

/* 指纹取条目的稳定投影。不含时刻 —— 含进去就等于每次都判「变了」，指纹也就不回答任何问题。 */
function fingerprintOf(palette: readonly PaletteEntry[]): string {
  return palette.map((entry) => `${entry.kind}:${entry.name}`).join('|')
}

export interface SnapshotCache {
  readonly read: () => ExtensionSnapshot
  readonly write: (palette: readonly PaletteEntry[], catalogFetchedAt: string) => void
}

export interface SnapshotCacheOptions {
  /** 领域层不摸时钟。测试因此不需要冻结全局时间。 */
  readonly now: () => string
}

export function createSnapshotCache(options: SnapshotCacheOptions): SnapshotCache {
  const preference = createPreference<ExtensionSnapshot>({
    key: SNAPSHOT_KEY,
    fallback: EMPTY_SNAPSHOT,
    /*
     * 解码不许抛：这条管线由第一帧同步调用，抛出去就等于开不了插件页。旧格式与坏文档一律
     * 回落到空快照 —— 快照丢了只是少一帧内容，不需要一层迁移代码来救。
     */
    decode: (raw) => {
      try {
        const parsed = v.safeParse(Document, JSON.parse(raw))

        return parsed.success ? parsed.output : EMPTY_SNAPSHOT
      } catch {
        return EMPTY_SNAPSHOT
      }
    },
    /* 空快照写成 null：那是「没有快照」，不是「快照说这里什么都没有」。 */
    encode: (value) =>
      value.palette.length === 0 && value.catalogFetchedAt === '' ? null : JSON.stringify(value),
    onFailure: (failure) => {
      warn('扩展快照没能存下来，下次打开要重新探测', { scope: 'plugins', ...failure })
    },
  })

  return {
    read: () => preference.read(),

    write(palette, catalogFetchedAt) {
      const fingerprint = fingerprintOf(palette)
      const previous = preference.read()

      if (previous.fingerprint === fingerprint && previous.catalogFetchedAt === catalogFetchedAt) {
        return
      }

      preference.write({
        format: SNAPSHOT_FORMAT,
        detectedAt: options.now(),
        catalogFetchedAt,
        fingerprint,
        palette: [...palette],
      })
    },
  }
}
