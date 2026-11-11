import { existsSync } from 'node:fs'
import path from 'node:path'
import { createCoreKernel } from '@poietica/core-kernel'
import { JournalServiceToken } from '@poietica/feature-journal/core-api'
import { PolicyServiceToken } from '@poietica/feature-policy/core-api'
import { systemClock } from '@poietica/foundation'
import { createLogger, jsonlFileSink } from '@poietica/logging'
import { appContract, PROTOCOL_VERSION } from '@poietica/protocol'
import { createStdioTransport } from '@poietica/rpc/stdio'
import { CORE_EXIT_CODES, dataLayout, parseCoreArgs } from '@poietica/runtime-layout'
import {
  installStdoutGuard,
  prepareIsolation,
  runIsolationSelfCheck,
} from '@poietica/runtime-protocol-omp/bootstrap/core'
import { coreModules, retiredCoreModules } from './modules'
import { CORE_VERSION } from './version'

export async function serve(): Promise<void> {
  const writeFrame = installStdoutGuard() // 1. 此后 stdout 只允许写帧；杂散输出全部改到 stderr
  let args: ReturnType<typeof parseCoreArgs>
  try {
    args = parseCoreArgs(process.argv) // 2. --data-root、--log-level、--strict（缺必填参数：退出码 2）
  } catch (e) {
    process.stderr.write(`poietica-core: ${e instanceof Error ? e.message : String(e)}\n`)
    process.exit(CORE_EXIT_CODES.badArguments)
  }
  const layout = dataLayout(args.dataRoot) // 3. 与 Host 共用同一份布局定义
  prepareIsolation(layout) // 4. 再次强制隔离变量；chdir 到 core/cwd（空目录）
  // 5. scrubInjected 内部先导入 pi-utils 触发 .env 加载，随即删除注入的键 + omp 认识的凭据变量
  //    （只返回键名）。本文件不 import 任何 @oh-my-pi/*（03 页 §9 omp-confined）。
  /* runtime 进程自己在 runtime-entry 里快照并清洗环境；Core 不引 omp 的 .env 加载器。 */
  const scrubbed: readonly string[] = []
  let logLevel = args.logLevel //    级别可在运行时由 diagnostics.setLogLevel 调整
  //    Core 自己写 logs/core.log（按批落盘、error 当场落盘）：不再把每条日志序列化到 stderr、让 Host 在 Electron
  //    主线程上逐行解析再写一遍。stderr 只剩意外输出，Host 记进 main.log（host-kernel/src/core-output.ts）。
  const coreLog = jsonlFileSink({ file: layout.coreLog })
  process.on('exit', () => coreLog.close())
  const logger = createLogger({ level: () => logLevel, sinks: [coreLog], base: { proc: 'core' } })
  const check = await runIsolationSelfCheck(layout) // 6. 所有 omp 目录必须在 layout.ompRoot 之下
  if (!check.ok) {
    logger.error('isolation self-check failed', { violations: check.violations })
    process.exit(CORE_EXIT_CODES.isolationViolated) //    退出码 3：Host 不重启，横幅提示
  }
  const engine = await createRealEngine(layout, logger)
  const kernel = createCoreKernel({
    modules: coreModules,
    retiredModules: retiredCoreModules,
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
  // 8. 先挂退出回调再启动：启动途中 Host 断开 / 要求关停时，关停跑完就得退出，不能等 start 返回才挂
  kernel.onExit((code) => process.exit(code)) //    core.shutdown 或 stdin 关闭 → kernel.shutdown → 退出码 0
  await kernel.start() // 9. 迁移 → 模块 setup → freezeTools → onReady → 发 core.ready
  if ('setToolPolicy' in engine) {
    const policy = kernel.services.get(PolicyServiceToken)
    const journal = kernel.services.get(JournalServiceToken)
    ;(
      engine as {
        setToolPolicy(
          p: (tool: { name: string; approval: 'read' | 'write' | 'exec'; cwd: string; sessionKey: string }) => unknown,
        ): void
      }
    ).setToolPolicy((tool) => {
      const classification =
        tool.approval === 'read'
          ? { category: 'file.read' as const, risk: 'low' as const, checkpoint: false }
          : tool.approval === 'write'
            ? { category: 'file.write' as const, risk: 'medium' as const, checkpoint: true }
            : { category: 'exec' as const, risk: 'high' as const, checkpoint: true }
      const decision = policy.evaluateClassification('auto-edit', classification, { workspaceRoot: tool.cwd })
      journal.append(tool.sessionKey, 'main', [
        {
          schema: 1,
          at: new Date().toISOString(),
          durability: 'committed',
          type: 'policy.decided',
          toolName: tool.name,
          category: classification.category,
          action: decision.action,
          rule: decision.rule,
          reason: decision.reason,
          preset: 'auto-edit',
        },
      ])
      return decision
    })
  }
  await Bun.write(path.join(layout.coreDir, 'core.pid'), String(process.pid))
}

async function createRealEngine(
  layout: Parameters<typeof createCoreKernel>[0]['layout'],
  logger: Parameters<typeof createCoreKernel>[0]['logger'],
) {
  if (process.env.POIETICA_RUNTIME_ARP !== '0') {
    const { ArpEngine } = await import('@poietica/runtime-manager')
    const bun = path.basename(process.execPath).toLowerCase().startsWith('bun')
    const runtimeExe = path.join(path.dirname(process.execPath), ['poietica-runtime', 'exe'].join('.'))
    const standalone = !bun && existsSync(runtimeExe)
    return ArpEngine.connect({
      launch: {
        command: standalone ? runtimeExe : process.execPath,
        args: standalone
          ? ['--data-root', layout.root]
          : bun
            ? [process.argv[1]!, 'runtime', '--data-root', layout.root]
            : ['runtime', '--data-root', layout.root],
      },
      logger: logger.child({ module: 'runtime' }),
    })
  }
  throw new Error('POIETICA_RUNTIME_ARP=0 已移除：Core 必须连接独立的 runtime 可执行文件')
}
