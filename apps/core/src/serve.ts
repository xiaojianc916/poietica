import path from 'node:path'
import { createCoreKernel } from '@poietica/core-kernel'
import {
  installStdoutGuard,
  type LaunchEnv,
  prepareIsolation,
  runIsolationSelfCheck,
} from '@poietica/engine-omp/bootstrap'
import { systemClock } from '@poietica/foundation'
import { createLogger, stderrJsonSink } from '@poietica/logging'
import { appContract, PROTOCOL_VERSION } from '@poietica/protocol'
import { createStdioTransport } from '@poietica/rpc/stdio'
import { CORE_EXIT_CODES, dataLayout, parseCoreArgs } from '@poietica/runtime-layout'
import { coreModules } from './modules'
import { CORE_VERSION } from './version'

export async function serve(launchEnv: LaunchEnv): Promise<void> {
  const writeFrame = installStdoutGuard() // 1. 此后 stdout 只允许写帧；杂散输出全部改到 stderr
  let args: ReturnType<typeof parseCoreArgs>
  try {
    args = parseCoreArgs(process.argv) // 2. --data-root、--log-level、--relay-port、--strict（缺必填参数：退出码 2）
  } catch (e) {
    process.stderr.write(`poietica-core: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(CORE_EXIT_CODES.badArguments)
  }
  const layout = dataLayout(args.dataRoot) // 3. 与 Host 共用同一份布局定义
  prepareIsolation(layout) // 4. 再次强制隔离变量；chdir 到 core/cwd（空目录）
  // 5. scrubInjected 内部先导入 pi-utils 触发 .env 加载，随即删除注入的键 + omp 认识的凭据变量
  //    （只返回键名）。本文件不 import 任何 @oh-my-pi/*（03 页 §9 omp-confined）。
  const scrubbed = await launchEnv.scrubInjected()
  let logLevel = args.logLevel //    级别可在运行时由 diagnostics.setLogLevel 调整
  const logger = createLogger({ level: () => logLevel, sinks: [stderrJsonSink()], base: { proc: 'core' } })
  if (scrubbed.length > 0) logger.info('scrubbed injected env', { keys: scrubbed })
  const check = await runIsolationSelfCheck(layout) // 6. 所有 omp 目录必须在 layout.ompRoot 之下
  if (!check.ok) {
    logger.error('isolation self-check failed', { violations: check.violations })
    process.exit(CORE_EXIT_CODES.isolationViolated) //    退出码 3：Host 不重启，横幅提示
  }
  const engine = args.probeMockModel
    ? await createProbeEngine(layout, logger)
    : await createRealEngine(layout, args.relayPort, logger)
  const kernel = createCoreKernel({
    modules: coreModules,
    engine,
    layout,
    logger,
    clock: systemClock,
    databaseFile: layout.dbFile,
    transport: createStdioTransport({
      input: process.stdin,
      writeFrame,
      onStray: (line) => logger.warn('stray stdin', { line }),
    }),
    appContract,
    protocolVersion: PROTOCOL_VERSION,
    coreVersion: CORE_VERSION,
    engineVersion: engine.info.version,
    strict: args.strict,
    runtime: {
      scrubbedEnvKeys: scrubbed,
      setLogLevel: (level) => {
        logLevel = level
      },
    },
  })
  await kernel.start() // 8. 迁移 → 模块 setup → freezeTools → onReady → 发 core.ready
  await Bun.write(path.join(layout.coreDir, 'core.pid'), String(process.pid))
  kernel.onExit((code) => process.exit(code)) // 9. core.shutdown 或 stdin 关闭 → kernel.shutdown → 退出码 0
}

async function createRealEngine(
  layout: Parameters<typeof createCoreKernel>[0]['layout'],
  relayPort: number,
  logger: Parameters<typeof createCoreKernel>[0]['logger'],
) {
  const { createOmpEngine } = await import('@poietica/engine-omp')
  // appVersion 必给；engineVersion 由 engine-omp 自己从 omp 的 package.json 读（只有它能 import @oh-my-pi/*）。
  // 两个都不能缺：engine.info.version 会成为 core.ready 载荷与 diagnostics.core 的 engineVersion，
  // 契约要求它是 string —— undefined 会让 strict 模式下的 diagnostics.core 整个方法失败。
  return createOmpEngine({ layout, relayPort, logger: logger.child({ module: 'engine' }), appVersion: CORE_VERSION })
}

/**
 * 探针版专用：只有编译期注入 POIETICA_PROBE_BUILD="1" 时，args.probeMockModel 才可能为真
 * （parseCoreArgs 在正式版遇到 --probe-mock-model 会报未知参数、退出码 2）。
 * 正式版里这个条件是编译期常量 false，整个分支连同下面的动态 import 会被打包器剔除，
 * 所以正式 exe 里没有任何测试代码。
 */
async function createProbeEngine(
  layout: Parameters<typeof createCoreKernel>[0]['layout'],
  logger: Parameters<typeof createCoreKernel>[0]['logger'],
) {
  if (process.env.POIETICA_PROBE_BUILD !== '1') {
    throw new Error('--probe-mock-model 只能用于探针版')
  }
  const { createOmpEngineForTest } = await import('@poietica/engine-omp/testing')
  const handle = await createOmpEngineForTest({ layout, logger: logger.child({ module: 'engine' }) })
  return handle.engine
}
