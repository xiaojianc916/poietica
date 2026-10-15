import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { type EarlyMessagePort, holdEarlyMessages, ompCliSelfDispatches } from '../worker-dispatch'

/*
 * R-20-2：worker 子进程 / 线程里 omp 的 worker 入口被跑了两遍。omp 的 cli.ts 被 import 时自己就会按 argv 派发
 * （编译版与 worker 线程），Poietica 又 runCli 一次 —— eval 报「another same-realm JS runtime is running」、
 * broker 抢同一根命名管道。
 */
describe('omp cli 是否自派发（R-20-2）', () => {
  test('真值表：编译版或 worker 线程里 cli 自己派发；只有开发版的主线程要我们派发', () => {
    expect(ompCliSelfDispatches(true, true)).toBe(true)
    expect(ompCliSelfDispatches(true, false)).toBe(true)
    expect(ompCliSelfDispatches(false, false)).toBe(true)
    expect(ompCliSelfDispatches(false, true)).toBe(false)
  })

  /* omp 知识 #1 的钉子：升级 omp 后这两行变了，`ompCliSelfDispatches` 的判据就得跟着重看 */
  test('omp cli.ts 的自派发条件没有变', () => {
    const source = readFileSync(fileURLToPath(import.meta.resolve('@oh-my-pi/pi-coding-agent/cli')), 'utf8')
    expect(source).toContain('const isProcessEntry = import.meta.main || process.env.PI_COMPILED === "true"')
    expect(source).toContain('if (isProcessEntry || !Bun.isMainThread) {')
    expect(source).toContain('runCli(process.argv.slice(2))')
  })
})

/** 记账的假 port：按注册顺序分发，`off` 真的摘掉 */
function fakePort() {
  const listeners: { event: string; listener: (value: unknown) => void }[] = []
  const port: EarlyMessagePort & { post(value: unknown): void; count(): number } = {
    on(event, listener) {
      listeners.push({ event, listener })
      return port
    },
    off(event, listener) {
      const at = listeners.findIndex((entry) => entry.event === event && entry.listener === listener)
      if (at >= 0) listeners.splice(at, 1)
      return port
    },
    post(value) {
      for (const entry of [...listeners]) if (entry.event === 'message') entry.listener(value)
    },
    count: () => listeners.filter((entry) => entry.event === 'message').length,
  }
  return port
}

describe('holdEarlyMessages（R-20-2）', () => {
  test('第一个 message 监听者按顺序收到早到的消息，之后只走它自己的路', () => {
    const port = fakePort()
    const originalOn = port.on
    holdEarlyMessages(port)
    port.post('init')
    port.post('run-1')

    const got: unknown[] = []
    port.on('message', (value) => got.push(value))
    expect(got).toEqual(['init', 'run-1'])
    /* 缓存监听者已经摘掉、`on` 换回原样 */
    expect(port.count()).toBe(1)
    expect(port.on).toBe(originalOn)

    port.post('run-2')
    expect(got).toEqual(['init', 'run-1', 'run-2'])
  })

  test('别的事件名不触发交接', () => {
    const port = fakePort()
    holdEarlyMessages(port)
    port.post('init')
    port.on('close', () => undefined)

    const got: unknown[] = []
    port.on('message', (value) => got.push(value))
    expect(got).toEqual(['init'])
  })

  test('超时没人来接：摘掉缓存监听者并清空，之后注册的监听者不再收到旧消息', async () => {
    const port = fakePort()
    const originalOn = port.on
    holdEarlyMessages(port, 5)
    port.post('init')
    await Bun.sleep(20)

    expect(port.count()).toBe(0)
    expect(port.on).toBe(originalOn)
    const got: unknown[] = []
    port.on('message', (value) => got.push(value))
    expect(got).toEqual([])
  })
})
