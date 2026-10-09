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
}

/**
 * 同步追加写（进程崩溃前的最后几行也不会丢）。轮转：file → file.1 → file.2 …，超出 keep 的最旧文件删除。
 * 写入失败（磁盘满、文件被占用）时丢弃该条并在 stderr 打印一次提示，之后静默。
 */
export function jsonlFileSink(o: JsonlFileSinkOptions): LogSink & { close(): void } {
  const maxBytes = o.maxBytes ?? 5 * 1024 * 1024
  const keep = o.keep ?? 3
  let fd: number | null = null
  let size = 0
  let warned = false

  const open = (): number => {
    mkdirSync(path.dirname(o.file), { recursive: true })
    const handle = openSync(o.file, 'a')
    size = existsSync(o.file) ? statSync(o.file).size : 0
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

  return {
    write(record) {
      try {
        const line = `${JSON.stringify(redactSecrets(record))}\n`
        const bytes = Buffer.byteLength(line)
        if (fd !== null && size > 0 && size + bytes > maxBytes) rotate()
        const handle = fd ?? open()
        writeSync(handle, line)
        size += bytes
      } catch (e) {
        if (!warned) {
          warned = true
          process.stderr.write(`[logging] 无法写入 ${o.file}：${String(e)}\n`)
        }
      }
    },
    close() {
      if (fd !== null) {
        closeSync(fd)
        fd = null
      }
    },
  }
}
