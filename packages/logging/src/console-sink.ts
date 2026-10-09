import type { LogSink } from './logger'
import { redactSecrets } from './redact'

/**
 * 开发版的控制台 sink：`12:34:56.789 INFO  [scope] msg {data}`。生产环境不使用。
 * 它的职责就是把日志写到 console，这个文件在 biome.json 里按精确路径豁免 noConsole。
 */
export function consoleSink(): LogSink {
  return {
    write(record) {
      const { ts, level, msg, proc, module, scope, ...rest } = redactSecrets(record) as Record<string, unknown>
      const time = new Date(typeof ts === 'number' ? ts : Date.now()).toISOString().slice(11, 23)
      const tag = [proc, module, scope].filter((x) => typeof x === 'string').join('/')
      const head = `${time} ${String(level).toUpperCase().padEnd(5)} [${tag}] ${String(msg)}`
      const tail = Object.keys(rest).length > 0 ? rest : ''
      if (level === 'error') console.error(head, tail)
      else if (level === 'warn') console.warn(head, tail)
      else console.log(head, tail)
    },
  }
}
