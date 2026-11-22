import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { defineCoreModule } from '@poietica/core-kernel'
import { AppError } from '@poietica/foundation'
import { isInside } from '@poietica/fs-kit'
import { pathKey } from '@poietica/platform-kit'
import type { PythonStatus } from '../contract'
import { pythonContract, pythonErrors } from '../contract'
import { type CommandBytes, compareVersions, type DetectionDeps, detectPython, type PythonCandidate } from './detect'
import { createInstaller, type InstallerDeps } from './installer'
import { PYTHON_VERSION } from './release'
import { chooseCandidate, isSupported, statusOf } from './status'

/** 外部装了 / 卸了 Python 时，设置页重开能看见；不用每秒扫盘。 */
const REFRESH_INTERVAL_MS = 5_000

export interface PythonModuleOverrides {
  readonly detection?: {
    readonly run?: DetectionDeps['run']
    readonly exists?: DetectionDeps['exists']
    readonly readdir?: DetectionDeps['readdir']
    readonly which?: DetectionDeps['which']
    readonly env?: DetectionDeps['env']
  }
  readonly installer?: {
    readonly fetch?: InstallerDeps['fetch']
    readonly run?: InstallerDeps['run']
    readonly fs?: InstallerDeps['fs']
    readonly ulid?: InstallerDeps['ulid']
    readonly expectedSha256?: string
  }
}

export function createPythonModule(overrides: PythonModuleOverrides = {}) {
  return defineCoreModule({
    id: 'python',
    contract: pythonContract,
    setup(ctx) {
      const toolsDir = ctx.layout.toolsDir
      const pythonDir = ctx.layout.pythonDir

      let status = statusOf('absent')
      /** 每次安装 / 强制刷新加一：正在跑的旧探测回来时不能覆盖新状态。 */
      let generation = 0
      let detecting: Promise<PythonStatus> | null = null
      let lastRefreshAt = 0

      const setStatus = (next: PythonStatus): void => {
        status = next
        ctx.rpc.emit('python.statusChanged', status)
      }

      const installer = createInstaller(
        {
          fetch:
            overrides.installer?.fetch ??
            (async (url, init) => {
              const response = (await fetch(url, init)) as unknown as {
                ok: boolean
                status: number
                headers: { get(name: string): string | null }
                body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null
              }
              return response
            }),
          run: overrides.installer?.run ?? runText,
          fs: overrides.installer?.fs ?? {
            mkdir: async (target, opts) => {
              await mkdir(target, { recursive: opts?.recursive ?? false })
            },
            remove: (target, opts) => rm(target, { recursive: opts?.recursive ?? false, force: true }),
            writeFile: async (target, data) => {
              await Bun.write(target, data)
            },
          },
          ulid: overrides.installer?.ulid ?? (() => Bun.randomUUIDv7()),
          log: (level, message, data) => ctx.logger[level](message, data),
          report: (next) => {
            if (next.kind === 'downloading') setStatus(statusOf('downloading', { progress: next.progress }))
            else setStatus(statusOf('installing'))
          },
          now: () => ctx.clock.now(),
          ...(overrides.installer?.expectedSha256 === undefined
            ? {}
            : { expectedSha256: overrides.installer.expectedSha256 }),
        },
        toolsDir,
      )

      const detectionDeps: DetectionDeps = {
        run: overrides.detection?.run ?? runBytes,
        exists: overrides.detection?.exists ?? fileExists,
        readdir: overrides.detection?.readdir ?? readdirNames,
        which: overrides.detection?.which ?? (async (name) => Bun.which(name)),
        env: overrides.detection?.env ?? process.env,
        legacyDir: pythonDir,
        /* 每次探测时按当时的 python.interpreter 覆盖。 */
        current: null,
        log: (level, message, data) => ctx.logger[level](message, data),
      }

      const readInterpreter = async (): Promise<string | null> => {
        try {
          /* 端口类型是 string | null，但跨进程桥接可能把空值折成空对象；这里按实际值收一次口，
           * 否则下面会把它当路径去 isInside / pathKey。 */
          const value: unknown = await ctx.agentRuntime.settings.getPythonInterpreter()
          return typeof value === 'string' && value.length > 0 ? value : null
        } catch (e) {
          ctx.logger.warn('读取 python.interpreter 失败', { error: String(e) })
          return null
        }
      }

      const applyInterpreter = async (current: string | null, chosenPath: string): Promise<void> => {
        if (current !== null && pathKey(current) === pathKey(chosenPath)) return
        try {
          await ctx.agentRuntime.settings.setPythonInterpreter(chosenPath)
        } catch (e) {
          ctx.logger.warn('写入 python.interpreter 失败', { path: chosenPath, error: String(e) })
        }
      }

      const statusFor = (chosen: PythonCandidate): PythonStatus =>
        isSupported(chosen.version)
          ? statusOf('ready', { version: chosen.version, interpreter: chosen.path })
          : statusOf('outdated', { version: chosen.version, interpreter: chosen.path })

      /** 探测本机 Python，选中一个；`preferDetected` 给刚装完用，其它时候尊重已经配置好的解释器。 */
      const detectAndApply = async (preferDetected: boolean, gen: number): Promise<PythonStatus> => {
        const current = await readInterpreter()
        const candidates = await detectPython({ ...detectionDeps, current })
        /* 探测期间用户点了安装：这次结果已经过期，连设置都不能回写（否则会把新装的路径盖回旧的）。 */
        if (gen !== generation) return status

        const chosen = chooseCandidate({ candidates, current, preferDetected })
        if (chosen === null) return statusOf('absent')

        await applyInterpreter(current, chosen.path)
        return statusFor(chosen)
      }

      const refresh = async (options: { readonly force?: boolean } = {}): Promise<PythonStatus> => {
        if (isBusy(status)) return status
        if (options.force !== true && ctx.clock.now() - lastRefreshAt < REFRESH_INTERVAL_MS) return status
        if (detecting !== null) return detecting

        const gen = ++generation
        const task = (async (): Promise<PythonStatus> => {
          try {
            const next = await detectAndApply(false, gen)
            if (gen === generation && !isBusy(status)) setStatus(next)
          } catch (e) {
            ctx.logger.warn('探测本机 Python 失败', { error: String(e) })
          }
          return status
        })()
        detecting = task
        try {
          return await task
        } finally {
          if (detecting === task) detecting = null
          lastRefreshAt = ctx.clock.now()
        }
      }

      const failWith = (code: string, message: string): PythonStatus => {
        setStatus(statusOf('failed', { error: { code, message } }))
        return status
      }

      const failureOf = (e: unknown): { code: string; message: string } =>
        e instanceof AppError
          ? { code: e.code, message: e.message }
          : { code: pythonErrors.install_failed, message: String(e) }

      const runInstall = async (): Promise<PythonStatus> => {
        try {
          await installer.install()
          const next = await detectAndApply(true, generation)
          /* 装完必须真的看到钉住的版本：安装器说成功、探测却还是旧版本时，不能报 ready 糊弄过去。 */
          if (next.state !== 'ready' || next.version === null || compareVersions(next.version, PYTHON_VERSION) < 0) {
            return failWith(pythonErrors.verify_failed, 'Python 安装后没有找到可用版本')
          }
          setStatus(next)
          return status
        } catch (e) {
          const failure = failureOf(e)
          ctx.logger.warn('Python 安装失败', { code: failure.code, error: failure.message })
          return failWith(failure.code, failure.message)
        }
      }

      const installNow = async (): Promise<PythonStatus> => {
        if (isBusy(status)) return status
        /* 已经 ready 就没什么可装的：重复触发不该再拉一遍 36 MB 安装包。 */
        if (status.state === 'ready') return status

        /* 让正在跑的旧探测作废：它不能把「正在下载」盖回去。 */
        generation += 1
        return runInstall()
      }

      /** 用户要求清掉旧版内置解释器：整个目录不再需要，指进去的 python.interpreter 也一起清空。 */
      const removeLegacyInstall = async (): Promise<void> => {
        const current = await readInterpreter()
        if (current !== null && isInside(pythonDir, current)) {
          try {
            await ctx.agentRuntime.settings.setPythonInterpreter(null)
          } catch (e) {
            ctx.logger.warn('清空旧版内置 Python 设置失败', { error: String(e) })
          }
        }

        await removeLegacyInstallFiles({
          pythonDir,
          toolsDir,
          log: (level, message, data) => ctx.logger[level](message, data),
        })
      }

      ctx.lifecycle.onReady(async () => {
        await removeLegacyInstall()
        await refresh({ force: true })
      })

      ctx.rpc.handle('python.status', () => refresh())
      ctx.rpc.handle('python.install', () => installNow())

      ctx.lifecycle.onShutdown(() => {
        installer.abort()
      })
    },
  })
}

/**
 * 旧版把解释器装在产品数据目录里；现在改回系统 Python，这份副本连同它的暂存目录一起删掉。
 * 抽成纯函数是为了能直接用真实临时目录测（内核 harness 的数据根在 onReady 之后才拿得到）。
 */
export async function removeLegacyInstallFiles(args: {
  readonly pythonDir: string
  readonly toolsDir: string
  readonly log: (level: 'info' | 'warn', message: string, data?: Record<string, unknown>) => void
}): Promise<void> {
  if (await fileExists(args.pythonDir)) {
    try {
      await rm(args.pythonDir, { recursive: true, force: true })
      args.log('info', '已清理旧版内置 Python 目录', { path: args.pythonDir })
    } catch (e) {
      args.log('warn', '清理旧版内置 Python 目录失败', { path: args.pythonDir, error: String(e) })
    }
  }

  if (!(await fileExists(args.toolsDir))) return

  for (const pattern of ['python.staging-*', 'python.old-*', 'python-setup-*']) {
    try {
      for await (const entry of new Bun.Glob(pattern).scan({ cwd: args.toolsDir, onlyFiles: false })) {
        const target = path.join(args.toolsDir, entry)
        await rm(target, { recursive: true, force: true })
        args.log('info', '已清理 Python 安装残留', { target })
      }
    } catch (e) {
      args.log('warn', `清理 ${pattern} 失败`, { error: String(e) })
    }
  }
}

/** 安装器 / 探测都要同步读完输出再等退出码，避免管道写满把子进程卡住。 */
async function runBytes(cmd: string, args: readonly string[], timeoutMs: number): Promise<CommandBytes> {
  try {
    const proc = Bun.spawn([cmd, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
      env: process.env,
    })
    const [stdout, stderr] = await Promise.all([
      Bun.readableStreamToArrayBuffer(proc.stdout),
      Bun.readableStreamToArrayBuffer(proc.stderr),
    ])
    const code = await proc.exited
    return { stdout: new Uint8Array(stdout), stderr: new Uint8Array(stderr), code }
  } catch (e) {
    return { stdout: new Uint8Array(), stderr: new TextEncoder().encode(String(e)), code: -1 }
  }
}

async function runText(
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const result = await runBytes(cmd, args, timeoutMs)
  return {
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
    code: result.code,
  }
}

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

async function readdirNames(dir: string): Promise<readonly string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

function isBusy(current: PythonStatus): boolean {
  return current.state === 'downloading' || current.state === 'installing'
}

export default createPythonModule()
