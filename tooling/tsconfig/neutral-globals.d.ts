// 三种运行时（Chromium、Node/Electron、Bun）共有的 Web 标准全局对象的最小声明，仅供 neutral 预设使用。
interface TimerHandle {
  readonly __timerHandle: never
}
declare function setTimeout(handler: () => void, timeout?: number): TimerHandle
declare function clearTimeout(handle: TimerHandle | undefined): void
declare function setInterval(handler: () => void, timeout?: number): TimerHandle
declare function clearInterval(handle: TimerHandle | undefined): void
declare function queueMicrotask(callback: () => void): void
declare function structuredClone<T>(value: T): T

interface Console {
  debug(...data: unknown[]): void
  info(...data: unknown[]): void
  log(...data: unknown[]): void
  warn(...data: unknown[]): void
  error(...data: unknown[]): void
}
declare const console: Console

interface AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
  throwIfAborted(): void
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}
declare const AbortSignal: {
  prototype: AbortSignal
  abort(reason?: unknown): AbortSignal
  timeout(milliseconds: number): AbortSignal
  any(signals: AbortSignal[]): AbortSignal
}
interface AbortController {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}
declare const AbortController: { prototype: AbortController; new (): AbortController }

interface Crypto {
  getRandomValues<T extends Uint8Array>(array: T): T
  randomUUID(): string
}
declare const crypto: Crypto

interface TextEncoder {
  encode(input?: string): Uint8Array
}
declare const TextEncoder: { prototype: TextEncoder; new (): TextEncoder }
interface TextDecoder {
  decode(input?: Uint8Array, options?: { stream?: boolean }): string
}
declare const TextDecoder: { prototype: TextDecoder; new (label?: string): TextDecoder }
