import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import path from 'node:path'
import type { LogSink } from './logger'
import { redactSecrets } from './redact'

export interface JsonlFileSinkOptions {
  readonly file: string
  /** 单个文件的最大字节数，超过后轮转。默认 5 MB */
  readonly maxBytes?: number
  /** 保留的历史文件个数（file.1 … file.<keep>）。默认 3 */
  readonly keep?: number
  /**
   * 普通记录攒多久落一次盘（毫秒），默认 250。error 级记录、攒满 64 KB、`flush()` / `close()` 都立刻落盘；
   * 0 = 每条同步写。
   */
  readonly flushMs?: number
}

export interface JsonlFileSink extends LogSink {
  /** 把攒着的记录同步写盘：进程退出前（`process.on('exit')`）与崩溃处理里调用 */
  flush(): void
  close(): void
}

/** 攒到这么多字节就不等定时器了：一次突发不至于在内存里堆太多 */
const FLUSH_BYTES = 64 * 1024

interface PendingLine {
  readonly text: string
  readonly bytes: number
}

/**
 * 追加写 JSONL，**按批同步落盘**：普通记录攒 `flushMs` 再一次 writeSync，error 级记录立刻连同
 * 前面攒着的一起写。Host 的 sink 跑在 Electron 主线程上，每条日志一次系统调用（杀软实时扫描时更慢），
 * 突发几百条就是界面卡顿；崩溃安全的取舍是 error 级当场落盘、flush() 交给退出钩子，只有被强杀
 * 才可能丢掉最后 250ms 的 info / debug。
 * 轮转：file → file.1 → file.2 …，超出 keep 删最旧；一批记录跨过上限时在行边界切开，当前文件不超过
 * maxBytes。写入失败（磁盘满、文件被占用）丢弃这一批并在 stderr 提示一次，之后静默。
 */
export function jsonlFileSink(o: JsonlFileSinkOptions): JsonlFileSink {
  const maxBytes = o.maxBytes ?? 5 * 1024 * 1024
  const keep = o.keep ?? 3
  const flushMs = o.flushMs ?? 250
  let fd: number | null = null
  let size = 0
  let warned = false
  let pending: PendingLine[] = []
  let pendingBytes = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const warnOnce = (e: unknown): void => {
    if (warned) return
    warned = true
    process.stderr.write(`[logging] 无法写入 ${o.file}：${String(e)}\n`)
  }

  const open = (): number => {
    mkdirSync(path.dirname(o.file), { recursive: true })
    const handle = openSync(o.file, 'a')
    size = statSync(o.file, { throwIfNoEntry: false })?.size ?? 0
    fd = handle
    return handle
  }

  const rotate = (): void => {
    if (fd !== null) {
      closeSync(fd)
      fd = null
    }
    rmSync(`${o.file}.${keep}`, { force: true })
    for (let i = keep - 1; i >= 1; i--) {
      if (existsSync(`${o.file}.${i}`)) renameSync(`${o.file}.${i}`, `${o.file}.${i + 1}`)
    }
    if (existsSync(o.file)) renameSync(o.file, `${o.file}.1`)
  }

  const append = (text: string, bytes: number): void => {
    writeSync(fd ?? open(), text)
    size += bytes
  }

  /** 按行边界分段写入：一批记录跨过 maxBytes 时先写满当前文件、轮转，再写剩下的 */
  const writeLines = (lines: readonly PendingLine[]): void => {
    if (fd === null) open()
    let segment = ''
    let segmentBytes = 0
    for (const line of lines) {
      const projected = size + segmentBytes
      if (projected > 0 && projected + line.bytes > maxBytes) {
        if (segmentBytes > 0) append(segment, segmentBytes)
        rotate()
        open()
        segment = ''
        segmentBytes = 0
      }
      segment += line.text
      segmentBytes += line.bytes
    }
    if (segmentBytes > 0) append(segment, segmentBytes)
  }

  const drain = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending.length === 0) return
    const lines = pending
    pending = []
    pendingBytes = 0
    try {
      writeLines(lines)
    } catch (e) {
      warnOnce(e)
    }
  }

  return {
    write(record) {
      let text: string
      try {
        text = `${JSON.stringify(redactSecrets(record))}\n`
      } catch (e) {
        warnOnce(e)
        return
      }
      const bytes = Buffer.byteLength(text)
      pending.push({ text, bytes })
      pendingBytes += bytes
      if (flushMs === 0 || record.level === 'error' || pendingBytes >= FLUSH_BYTES) {
        drain()
      } else if (timer === null) {
        timer = setTimeout(drain, flushMs)
        // 定时器不挂住进程：退出时由 flush() / close() 收尾
        timer.unref()
      }
    },
    flush: drain,
    close() {
      drain()
      if (fd !== null) {
        closeSync(fd)
        fd = null
      }
    },
  }
}
