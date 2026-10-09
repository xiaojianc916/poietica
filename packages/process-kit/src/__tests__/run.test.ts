import { describe, expect, test } from 'bun:test'
import { RunError, run } from '../run'

const NODE = process.execPath

describe('run', () => {
  test('运行到结束：收集 stdout 与退出码', async () => {
    const result = await run(NODE, ['-e', 'console.log("hi")'])
    expect(result.stdout).toBe('hi\n')
    expect(result.exitCode).toBe(0)
  })

  test('退出码不在 okExitCodes 时抛 RunError(exit)', async () => {
    const error = await run(NODE, ['-e', 'process.exit(3)']).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RunError)
    expect((error as RunError).reason).toBe('exit')
    expect((error as RunError).exitCode).toBe(3)
  })

  test('okExitCodes 含 3 时退出码 3 视为成功', async () => {
    const result = await run(NODE, ['-e', 'process.exit(3)'], { okExitCodes: [0, 3] })
    expect(result.exitCode).toBe(3)
  })

  test('input 原样写入 stdin', async () => {
    const result = await run(NODE, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'abc' })
    expect(result.stdout).toBe('abc')
  })

  test('超时：杀整棵进程树并在 1 秒内抛 RunError(timeout)', async () => {
    const started = Date.now()
    const error = await run(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 300 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RunError)
    expect((error as RunError).reason).toBe('timeout')
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test('中止：抛 RunError(aborted)', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const error = await run(NODE, ['-e', 'setTimeout(() => {}, 60000)'], { signal: controller.signal }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(RunError)
    expect((error as RunError).reason).toBe('aborted')
  })

  test('启动失败：reason 为 spawn', async () => {
    const error = await run('C:\\nope.exe', []).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(RunError)
    expect((error as RunError).reason).toBe('spawn')
  })

  test('参数含空格与引号时原样传递（不经 shell）', async () => {
    const result = await run(NODE, ['-e', 'console.log(process.argv[1])', 'a "b" c'])
    expect(result.stdout).toBe('a "b" c\n')
  })
})
