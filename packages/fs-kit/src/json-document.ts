import { readFile, rename } from 'node:fs/promises'
import type { Logger } from '@poietica/foundation'
import type { z } from 'zod'
import { writeFileAtomic } from './atomic'

export interface JsonDocument<T> {
  /** 读取并缓存。文件不存在 → defaults；JSON 损坏或校验失败 → 坏文件改名为 <file>.corrupt-<时间戳>，返回 defaults */
  load(): Promise<T>
  /** 当前缓存值（load 之前调用抛错） */
  current(): T
  /** 立即写入（串行化：并发调用按顺序写，最后一次为准） */
  save(value: T): Promise<void>
  /** 合并写入：debounceMs 内的多次调用只写最后一次 */
  saveDebounced(value: T): void
  /** 把待写的去抖内容立刻落盘（退出时调用） */
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

  const write = (v: T): Promise<void> => {
    chain = chain
      .then(() => writeFileAtomic(o.file, `${JSON.stringify(v, null, 2)}\n`))
      .catch((e: unknown) => {
        o.logger.error('json document write failed', { file: o.file, error: String(e) })
      })
    return chain
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
      value = v
      pending = undefined
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      return write(v)
    },
    saveDebounced(v) {
      value = v
      pending = v
      if (timer !== undefined) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        const p = pending
        pending = undefined
        if (p !== undefined) void write(p)
      }, debounceMs)
    },
    async flush() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      const p = pending
      pending = undefined
      if (p !== undefined) await write(p)
      await chain
    },
  }
}
