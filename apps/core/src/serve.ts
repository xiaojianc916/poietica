import { existsSync } from 'node:fs'
import path from 'node:path'
import { createCoreKernel } from '@poietica/core-kernel'
import { PolicyServiceToken } from '@poietica/feature-policy/core-api'
import { SettingsServiceToken } from '@poietica/feature-settings/core-api'
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
import { type SandboxLevel, type SandboxOptions, sandboxSelfCheck } from '@poietica/sandbox-win'
import { coreModules, featureDescriptors, retiredCoreModules } from './modules'
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
    moduleDescriptors: Object.values(featureDescriptors),
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
  if (hasToolPolicy(engine)) {
    const policy = kernel.services.get(PolicyServiceToken)
    const settings = kernel.services.get(SettingsServiceToken)
    /*
     * 引擎钩子与 `policy.check` RPC 走同一条：裁决、会话放行覆盖、写 Journal 都在 policy.check 里，
     * 这里只把引擎的入参翻译成它要的形状。产品工具带 spec.approval（分类由它自报），内置工具按名字查表。
     */
    engine.setToolPolicy((tool) => {
      const preset = (tool.preset ?? settings.get('policy.preset').value) as Parameters<typeof policy.evaluate>[0]
      const decision =
        tool.approval === undefined
          ? policy.check({
              sessionKey: tool.sessionKey,
              preset,
              toolName: tool.name,
              context: policyContextOf(tool.input ?? {}, tool.cwd),
            })
          : policy.check({
              sessionKey: tool.sessionKey,
              preset,
              toolName: tool.name,
              context: { workspaceRoot: tool.cwd },
              classification: classificationOfApproval(tool.approval),
            })
      return {
        action: decision.action,
        rule: decision.rule,
        reason: decision.reason,
        risk: decision.classification.risk,
        category: decision.classification.category,
        checkpoint: decision.classification.checkpoint,
      }
    })
    engine.setPolicyGrant?.((grant) => {
      policy.grant(grant)
    })
  }
  await Bun.write(path.join(layout.coreDir, 'core.pid'), String(process.pid))
}

interface PolicyToolContext {
  readonly name: string
  readonly approval?: 'read' | 'write' | 'exec'
  readonly cwd: string
  readonly sessionKey: string
  readonly preset?: 'ask' | 'auto-edit' | 'full-access'
  readonly input?: Record<string, unknown>
}

interface PolicyInstallable {
  setToolPolicy(policy: (tool: PolicyToolContext) => unknown): void
  setPolicyGrant?(grant: (input: { sessionKey: string; toolName: string }) => Promise<void> | void): void
}

function classificationOfApproval(approval: 'read' | 'write' | 'exec') {
  if (approval === 'read') return { category: 'file.read' as const, risk: 'low' as const, checkpoint: false }
  if (approval === 'write') return { category: 'file.write' as const, risk: 'medium' as const, checkpoint: true }
  return { category: 'exec' as const, risk: 'high' as const, checkpoint: true }
}

/** 运行时是否接受宿主策略注入（进程内替身没有这一格）。 */
function hasToolPolicy(engine: object): engine is PolicyInstallable {
  return 'setToolPolicy' in engine && typeof engine.setToolPolicy === 'function'
}

/**
 * 内置工具的裁决上下文：命令正文、它显式点名的路径，以及网络工具要访问的那个地址。
 * 路径按会话 cwd 解析，策略表只认绝对路径；URL 只认第一个像 http(s) 的字符串 ——
 * 网络出口规则按它的主机名判定（features/policy 的 networkDecision）。
 */
function policyContextOf(
  input: Record<string, unknown>,
  cwd: string,
): { workspaceRoot: string; command?: string; paths?: string[]; url?: string } {
  const command = typeof input.command === 'string' ? input.command : undefined
  const paths = new Set<string>()
  const add = (value: unknown): void => {
    if (typeof value !== 'string' || value === '') return
    paths.add(path.isAbsolute(value) ? value : path.resolve(cwd, value))
  }
  add(input.path)
  add(input.filePath)
  add(input.file_path)
  if (Array.isArray(input.paths)) for (const value of input.paths) add(value)
  if (typeof input.patch === 'string') {
    for (const line of input.patch.split(/\r?\n/)) {
      const match = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/.exec(line)
      if (match?.[1] !== undefined) add(match[1])
    }
  }
  const url = urlOf(input)
  return {
    workspaceRoot: cwd,
    ...(command === undefined ? {} : { command }),
    ...(paths.size === 0 ? {} : { paths: [...paths] }),
    ...(url === undefined ? {} : { url }),
  }
}

/** 网络工具的目标地址：omp 的 fetch 用 url、browser 用 url 或 target、MCP 远程服务器用 server。 */
function urlOf(input: Record<string, unknown>): string | undefined {
  for (const key of ['url', 'target', 'href', 'endpoint']) {
    const value = input[key]
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value
  }
  return undefined
}

async function resolveSandbox(logger: Parameters<typeof createCoreKernel>[0]['logger']): Promise<SandboxOptions> {
  const requested: SandboxLevel = process.env.POIETICA_SANDBOX === 'off' ? 'off' : 'job'
  if (requested === 'off') return { level: 'off' }
  const check = await sandboxSelfCheck(requested)
  if (check.ok) return { level: requested }
  /* 自检失败不静默降级：明确记一条，降级行为本身可审计。 */
  logger.warn('sandbox self-check failed; falling back to off', { level: requested, reason: check.reason })
  return { level: 'off' }
}

async function createRealEngine(
  layout: Parameters<typeof createCoreKernel>[0]['layout'],
  logger: Parameters<typeof createCoreKernel>[0]['logger'],
) {
  if (process.env.POIETICA_RUNTIME_ARP !== '0') {
    const { ArpEngine } = await import('@poietica/runtime-manager')
    const sandbox = await resolveSandbox(logger)
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
      sandbox,
    })
  }
  throw new Error('POIETICA_RUNTIME_ARP=0 已移除：Core 必须连接独立的 runtime 可执行文件')
}
