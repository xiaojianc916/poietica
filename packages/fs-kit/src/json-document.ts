import { readFile, rename } from 'node:fs/promises'
import type { Logger } from '@poietica/foundation'
import type { z } from 'zod'
import { writeFileAtomic } from './atomic'

export interface JsonDocument<T> {
  /** 读取并缓存。文件不存在 → defaults；JSON 损坏或校验失败 → 坏文件改名为 `<file>.corrupt-<时间戳>`，返回 defaults。 */
  load(): Promise<T>
  current(): T
  /**
   * 立即写入（并发调用按顺序串行化，最后一次为准）。写盘失败时 **reject**，且 current() 退回写之前的那一份
   * （期间又有新值写入时不退）—— 调用方据此决定「广播 / 报错」，不能把没落盘的值当成已保存。
   */
  save(value: T): Promise<void>
  /** 去抖写入：没有调用方能接住失败，失败只记 error 日志 */
  saveDebounced(value: T): void
  /** 把去抖中的值立即落盘并等所有写入结束。尽力而为、从不 reject（退出路径上要一个接一个 flush） */
  flush(): Promise<void>
}

export function createJsonDocument<S extends z.ZodTypeAny>(o: {
  file: string
  schema: S
  defaults: () => z.infer<S>
  logger: Logger
  debounceMs?: number
}): JsonDocument<z.infer<S>> {
  type T = z.infer<S>
  let value: T | undefined
  let chain: Promise<void> = Promise.resolve()
  let pending: T | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const debounceMs = o.debounceMs ?? 500

  /*
   * 链与这一次的结果分开：链吞掉失败（记日志），后一次写入不被前一次的失败牵连；
   * 返回给调用方的是**没吞**的那一个 —— 以前两者是同一个 Promise，save() 永远 resolve，写盘失败也被当成成功。
   */
  const write = (v: T): Promise<void> => {
    const run = chain.then(() => writeFileAtomic(o.file, `${JSON.stringify(v, null, 2)}\n`))
    chain = run.catch((e: unknown) => {
      o.logger.error('json document write failed', { file: o.file, error: String(e) })
    })
    return run
  }

  return {
    async load() {
      let text: string
      try {
        text = await readFile(o.file, 'utf8')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
          value = o.defaults()
          return value
        }
        throw e
      }
      const parsed = (() => {
        try {
          return o.schema.safeParse(JSON.parse(text))
        } catch {
          return null
        }
      })()
      if (parsed?.success) {
        value = parsed.data as T
        return value
      }
      const corrupt = `${o.file}.corrupt-${Date.now()}`
      await rename(o.file, corrupt).catch(() => undefined)
      o.logger.warn('json document invalid, using defaults', { file: o.file, movedTo: corrupt })
      value = o.defaults()
      return value
    },
    current() {
      if (value === undefined) throw new Error(`JsonDocument 未加载：${o.file}`)
      return value
    },
    save(v) {
      const prev = value
      value = v
      pending = undefined
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      return write(v).catch((e: unknown) => {
        if (value === v) value = prev
        throw e
      })
    },
    saveDebounced(v) {
      value = v
      pending = v
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        const p = pending
        pending = undefined
        if (p !== undefined) void write(p).catch(() => undefined)
      }, debounceMs)
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      const p = pending
      pending = undefined
      if (p !== undefined) await write(p).catch(() => undefined)
      await chain
    },
  }
}
