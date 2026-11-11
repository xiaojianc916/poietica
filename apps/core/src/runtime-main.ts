import { createLogger } from '@poietica/logging'
import { createStdioTransport } from '@poietica/rpc/stdio'
import { dataLayout } from '@poietica/runtime-layout'
import {
  installStdoutGuard,
  type LaunchEnv,
  prepareIsolation,
  runIsolationSelfCheck,
} from '@poietica/runtime-protocol-omp/bootstrap'
import { CORE_VERSION } from './version'

/**
 * Core 可执行文件的 `runtime` 模式：建 omp 引擎，把 ARP Worker 挂在 stdio 上。
 * 与 serve 模式共用同一个 exe；进程边界、隔离变量与 stdout 守卫都在这里先过一遍。
 *
 * 参数：`runtime --data-root <绝对路径> [--log-level <level>]`。
 */
export async function runRuntimeMode(launchEnv: LaunchEnv): Promise<never> {
  const writeFrame = installStdoutGuard()
  const args = process.argv[2] === 'runtime' ? process.argv.slice(3) : process.argv.slice(2)
  const root = flagValue(args, '--data-root')
  if (root === undefined) {
    process.stderr.write('poietica-core runtime: 缺少 --data-root\n')
    process.exit(2)
  }
  const level = flagValue(args, '--log-level') ?? 'info'
  const layout = dataLayout(root)
  prepareIsolation(layout)
  const scrubbed = await launchEnv.scrubInjected()
  const logger = createLogger({
    level: level as 'debug' | 'info' | 'warn' | 'error',
    sinks: [{ write: (record) => process.stderr.write(`${JSON.stringify(record)}\n`) }],
    base: { proc: 'runtime' },
  })
  const check = await runIsolationSelfCheck(layout)
  if (!check.ok) {
    logger.error('isolation self-check failed', { violations: check.violations })
    process.exit(3)
  }
  const { createOmpEngine, createOmpRuntimeWorker } = await import('@poietica/runtime-protocol-omp')
  const engine = await createOmpEngine({
    layout,
    logger: logger.child({ module: 'engine' }),
    appVersion: CORE_VERSION,
  })
  const worker = createOmpRuntimeWorker({
    engine,
    transport: createStdioTransport({
      input: process.stdin,
      writeFrame,
      onStray: (line) => logger.warn('stray stdin', { line }),
    }),
    logger,
    info: { runtimeVersion: CORE_VERSION, engineVersion: engine.info.version },
    onShutdown: () => {
      process.stdin.pause()
    },
  })
  const stop = async (): Promise<void> => {
    await worker.dispose()
    await engine.dispose()
    process.exit(0)
  }
  process.on('SIGTERM', () => void stop())
  process.on('SIGINT', () => void stop())
  process.stdin.on('end', () => void stop())
  if (scrubbed.length > 0) logger.info('scrubbed injected env', { keys: scrubbed })
  return new Promise<never>(() => undefined)
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}
