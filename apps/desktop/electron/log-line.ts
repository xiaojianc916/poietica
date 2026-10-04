/*
 * 一行日志正文的成形：**不依赖 electron**，所以能直接单测（与 native-paths.ts 分开的理由同款）。
 *
 * 形状与原生侧那份逐字段对齐（apps/desktop/native/src/log_file.rs 的 format_event）：
 * 同一个日志目录里两份文件，读的人不该因为换了文件就得换个解析器。
 */
import { redactText } from '@poietica/problem'

export interface LogLineInput {
  readonly data: readonly unknown[]
  readonly level: string
  readonly date: Date
}

/**
 * 一行 JSON。字段名对齐 OTel Logs 数据模型：`timestamp` / `level` / `target` / `message`。
 *
 * 脱敏在这里，不在调用点：一次覆盖全部来源（主进程、渲染层 spy、errorHandler、
 * eventLogger），而调用点会漏。判据与原生侧同源（Bearer、URL 里的凭据、敏感键、用户目录）。
 *
 * 转义交给 `JSON.stringify`：手写转义是第二份转义规则，而它出错时坏掉的是一整行。
 */
export function jsonLine({ data, level, date }: LogLineInput): string {
  const text = data.map(render).join(' ')

  return JSON.stringify({
    timestamp: date.toISOString(),
    level: level.toUpperCase(),
    target: 'main',
    message: redactText(text),
  })
}

/** 交给日志的可能是任何东西；字符串之外一律走 JSON，Error 取栈（message 常常只有一句码）。 */
export function render(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }

  if (value instanceof Error) {
    return value.stack ?? `${value.name}: ${value.message}`
  }

  if (value === undefined) {
    return 'undefined'
  }

  try {
    return JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}
