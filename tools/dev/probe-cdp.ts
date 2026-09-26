#!/usr/bin/env bun
/**
 * dev 探针共用的 Chromium CDP 脚手架：浏览器定位、引擎拉起、调试 WebSocket、
 * 求值与断言输出。probe-* 各探针只保留自己的页面与断言。
 */
import process from 'node:process'

const DEFAULT_BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/chromium',
  '/usr/bin/google-chrome',
]

export function resolveBrowser(): string {
  const argument = process.argv.indexOf('--browser')
  const browser = argument === -1 ? (process.env['DSH_CHROMIUM'] ?? '') : process.argv[argument + 1]
  const exe = browser === '' ? DEFAULT_BROWSERS.find((path) => Bun.file(path).size > 0) : browser

  if (exe === undefined) {
    console.error('找不到 Chromium：用 --browser <exe> 或 DSH_CHROMIUM 指一个。')

    process.exit(2)
  }

  return exe
}

export function launchEngine(
  exe: string,
  port: number,
  profile: string,
  windowSize: string,
): { kill(): void } {
  return Bun.spawn([
    exe,
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${windowSize}`,
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${String(port)}`,
    'about:blank',
  ])
}

export async function firstPage(port: number): Promise<{ webSocketDebuggerUrl: string }> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const list = (await (await fetch(`http://127.0.0.1:${String(port)}/json/list`)).json()) as {
        type: string
        webSocketDebuggerUrl: string
      }[]
      const page = list.find((target) => target.type === 'page')

      if (page !== undefined) {
        return page
      }
    } catch {
      /* 引擎还没起来 */
    }

    await Bun.sleep(200)
  }

  throw new Error('Chromium 没在 20 秒内开出调试端口。')
}

export interface Probe {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  evaluate(expression: string, awaitPromise?: boolean): Promise<never>
  close(): void
}

export async function attach(
  page: { webSocketDebuggerUrl: string },
  engine: { kill(): void },
): Promise<Probe> {
  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve) => socket.addEventListener('open', resolve))

  let sequence = 0
  const waiting = new Map<number, (message: { result?: unknown; error?: unknown }) => void>()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number
      result?: unknown
      error?: unknown
    }

    if (message.id !== undefined) {
      waiting.get(message.id)?.(message)
      waiting.delete(message.id)
    }
  })

  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((resolve, reject) => {
      sequence += 1
      const id = sequence
      waiting.set(id, (message) => {
        if (message.error === undefined) {
          resolve(message.result)
        } else {
          reject(new Error(JSON.stringify(message.error)))
        }
      })
      socket.send(JSON.stringify({ id, method, params }))
    })

  return {
    send,
    evaluate: async (expression: string, awaitPromise = false): Promise<never> =>
      (
        (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })) as {
          result: { value: never }
        }
      ).result.value,
    close: () => {
      socket.close()
      engine.kill()
    },
  }
}

export function checker(): {
  check(what: string, ok: boolean, detail: string): void
  passed(): boolean
  failureCount(): number
} {
  const failures: string[] = []
  const check = (what: string, ok: boolean, detail: string): void => {
    console.log(`${ok ? '  ok  ' : '  FAIL'} ${what} — ${detail}`)

    if (!ok) {
      failures.push(what)
    }
  }

  return { check, passed: () => failures.length === 0, failureCount: () => failures.length }
}
