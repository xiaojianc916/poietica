import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AppError } from '@poietica/foundation'
import { createTestLogger } from '@poietica/test-kit'
import { MAX_TERMINALS } from '../../contract/entities'
import { terminalErrors } from '../../contract/errors'
import { createTerminalService, type Pty, type PtyFactory } from '../terminal-service'

/* 假 PTY：可控地触发 onData / onExit，记录 write/resize/kill。 */
class FakePty implements Pty {
  readonly pid: number
  readonly written: string[] = []
  readonly resized: Array<{ cols: number; rows: number }> = []
  killed = false
  shellFile = ''
  cwd = ''
  cols = 0
  rows = 0
  env: Record<string, string> = {}
  private dataCb: ((data: string) => void) | null = null
  private exitCb: ((e: { exitCode: number }) => void) | null = null

  constructor(pid: number) {
    this.pid = pid
  }

  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.resized.push({ cols, rows })
  }
  kill(): void {
    this.killed = true
  }
  onData(cb: (data: string) => void): { dispose(): void } {
    this.dataCb = cb
    return { dispose: () => (this.dataCb = null) }
  }
  onExit(cb: (e: { exitCode: number }) => void): { dispose(): void } {
    this.exitCb = cb
    return { dispose: () => (this.exitCb = null) }
  }
  emitData(data: string): void {
    this.dataCb?.(data)
  }
  emitExit(exitCode: number): void {
    this.exitCb?.({ exitCode })
  }
}

function make(options: { readonly env?: NodeJS.ProcessEnv; readonly killTree?: (pid: number) => Promise<void> } = {}) {
  const logger = createTestLogger()
  const ptys: FakePty[] = []
  const output: Array<{ terminalId: string; data: string }> = []
  const exited: Array<{ terminalId: string; exitCode: number | null }> = []
  const spawn: PtyFactory = (shell, o) => {
    const pty = new FakePty(1000 + ptys.length)
    pty.shellFile = shell.file
    pty.cwd = o.cwd
    pty.cols = o.cols
    pty.rows = o.rows
    pty.env = o.env
    ptys.push(pty)
    return pty
  }

  const service = createTerminalService({
    spawn,
    logger,
    emitOutput: (terminalId, data) => output.push({ terminalId, data }),
    emitExited: (terminalId, exitCode) => exited.push({ terminalId, exitCode }),
    ...options,
  })

  return { service, ptys, output, exited, logger }
}

const tempDir = (): string => mkdtempSync(path.join(os.tmpdir(), 'poietica-terminal-'))

describe('TM-4: 数量上限', () => {
  test('第 11 个终端报 terminal.too_many；已退出的终端不计数', async () => {
    const { service, ptys } = make()
    const cwd = tempDir()
    try {
      for (let i = 0; i < MAX_TERMINALS; i += 1) {
        const info = await service.open({ cwd, cols: 80, rows: 24 })
        expect(info.terminalId).toBe(`t${i + 1}`)
      }

      const err = await service.open({ cwd, cols: 80, rows: 24 }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(AppError)
      expect((err as AppError).code).toBe(terminalErrors.too_many)

      /* 退出一个：名额让出来 */
      ptys[0]!.emitExit(0)
      const info = await service.open({ cwd, cols: 80, rows: 24 })
      expect(info.terminalId).toBe(`t${MAX_TERMINALS + 1}`)

      const all = await service.open({ cwd, cols: 80, rows: 24 }).catch((e: unknown) => e)
      expect((all as AppError).code).toBe(terminalErrors.too_many)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('TM-5: cwd', () => {
  test('不存在的目录 → terminal.cwd_not_found，且没有 spawn', async () => {
    const { service, ptys } = make()
    const missing = path.join(os.tmpdir(), 'poietica-terminal-missing-dir')
    const err = await service.open({ cwd: missing, cols: 80, rows: 24 }).catch((e: unknown) => e)
    expect((err as AppError).code).toBe(terminalErrors.cwd_not_found)
    expect(ptys.length).toBe(0)
  })

  test('cwd 是文件而不是目录 → terminal.cwd_not_found', async () => {
    const { service } = make()
    const dir = tempDir()
    const file = path.join(dir, 'a.txt')
    writeFileSync(file, 'x')
    try {
      const err = await service.open({ cwd: file, cols: 80, rows: 24 }).catch((e: unknown) => e)
      expect((err as AppError).code).toBe(terminalErrors.cwd_not_found)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('cwd 为 null 时用用户主目录', async () => {
    const { service, ptys } = make()
    const info = await service.open({ cwd: null, cols: 80, rows: 24 })
    expect(info.cwd).toBe(os.homedir())
    expect(ptys[0]!.cwd).toBe(os.homedir())
  })
})

describe('TM-6: 退出顺序', () => {
  test('先送出剩余输出，再 emitExited；list 中 exited=true', async () => {
    const { service, ptys, output, exited } = make()
    const cwd = tempDir()
    try {
      const info = await service.open({ cwd, cols: 80, rows: 24 })
      ptys[0]!.emitData('hello')
      expect(output.length).toBe(0)

      ptys[0]!.emitExit(3)
      /* drain 先跑：这一条输出必须排在 exited 之前 */
      expect(output).toEqual([{ terminalId: info.terminalId, data: 'hello' }])
      expect(exited).toEqual([{ terminalId: info.terminalId, exitCode: 3 }])
      expect(service.list().find((t) => t.terminalId === info.terminalId)?.exited).toBe(true)
      expect(service.list().find((t) => t.terminalId === info.terminalId)?.exitCode).toBe(3)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('已退出的终端：write / resize 不再落到 PTY 上', async () => {
    const { service, ptys } = make()
    const cwd = tempDir()
    try {
      const info = await service.open({ cwd, cols: 80, rows: 24 })
      ptys[0]!.emitExit(0)
      service.write(info.terminalId, 'x')
      service.resize(info.terminalId, 100, 40)
      expect(ptys[0]!.written).toEqual([])
      expect(ptys[0]!.resized).toEqual([])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('TM-8: disposeAll', () => {
  test('对每个未退出终端调用 killTree（注入的杀树器）', async () => {
    const killed: number[] = []
    const { service, ptys } = make({
      killTree: async (pid) => {
        killed.push(pid)
      },
    })
    const cwd = tempDir()
    try {
      await service.open({ cwd, cols: 80, rows: 24 })
      ptys[0]!.emitExit(0)
      await service.open({ cwd, cols: 80, rows: 24 })
      await service.open({ cwd, cols: 80, rows: 24 })

      await service.disposeAll()
      expect(killed).toEqual([1001, 1002])
      expect(service.list()).toEqual([])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('没有 killTree 时回落到 pty.kill()', async () => {
    const { service, ptys } = make()
    const cwd = tempDir()
    try {
      await service.open({ cwd, cols: 80, rows: 24 })
      await service.disposeAll()
      expect(ptys[0]!.killed).toBe(true)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('terminal-service 的其余规则', () => {
  test('网格被钳到 [2, 500] × [2, 200]', async () => {
    const { service, ptys } = make()
    const cwd = tempDir()
    try {
      await service.open({ cwd, cols: 1, rows: 1 })
      expect(ptys[0]!.cols).toBe(2)
      expect(ptys[0]!.rows).toBe(2)
      await service.open({ cwd, cols: 9999, rows: 9999 })
      expect(ptys[1]!.cols).toBe(500)
      expect(ptys[1]!.rows).toBe(200)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('未知 terminalId 的操作 → terminal.not_found', async () => {
    const { service } = make()
    const codeOf = (run: () => void): string => {
      try {
        run()
        return 'no-throw'
      } catch (e) {
        return e instanceof AppError ? e.code : String(e)
      }
    }
    expect(codeOf(() => service.write('t404', 'x'))).toBe(terminalErrors.not_found)
    expect(codeOf(() => service.replay('t404'))).toBe(terminalErrors.not_found)
    expect(codeOf(() => service.resize('t404', 80, 24))).toBe(terminalErrors.not_found)
    const err = await service.close('t404').catch((e: unknown) => e)
    expect((err as AppError).code).toBe(terminalErrors.not_found)
  })

  test('replay 返回最近输出的拼接（256 KB 环上裁剪由 RingBuffer 测）', async () => {
    const { service, ptys } = make()
    const cwd = tempDir()
    try {
      const info = await service.open({ cwd, cols: 80, rows: 24 })
      ptys[0]!.emitData('a')
      ptys[0]!.emitData('b')
      expect(service.replay(info.terminalId)).toBe('ab')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('close 把终端从 list 里摘掉并杀树', async () => {
    const killed: number[] = []
    const { service } = make({
      killTree: async (pid) => {
        killed.push(pid)
      },
    })
    const cwd = tempDir()
    try {
      const info = await service.open({ cwd, cols: 80, rows: 24 })
      await service.close(info.terminalId)
      expect(killed).toEqual([1000])
      expect(service.list()).toEqual([])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('spawn 抛错 → terminal.spawn_failed，且错误经 logger 记下', async () => {
    const logger = createTestLogger()
    const service = createTerminalService({
      spawn: () => {
        throw new Error('no conpty')
      },
      logger,
      emitOutput: () => undefined,
      emitExited: () => undefined,
    })
    const cwd = tempDir()
    try {
      const err = await service.open({ cwd, cols: 80, rows: 24 }).catch((e: unknown) => e)
      expect((err as AppError).code).toBe(terminalErrors.spawn_failed)
      expect(logger.at('error').map((r) => r.msg)).toContain('pty spawn failed')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
