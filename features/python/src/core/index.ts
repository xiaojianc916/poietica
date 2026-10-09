import path from 'node:path'
import { defineCoreModule } from '@poietica/core-kernel'
import { AppError } from '@poietica/foundation'
import { pythonContract, pythonErrors } from '../contract'
import { createInstaller } from './installer'
import { onReadyPlan, statusOf } from './status'

export default defineCoreModule({
  id: 'python',
  contract: pythonContract,
  setup(ctx) {
    const toolsDir = ctx.layout.toolsDir
    const pythonDir = ctx.layout.pythonDir
    const markerPath = path.join(pythonDir, 'poietica-python.json')

    let status = statusOf('absent')
    const installer = createInstaller(
      {
        fetch: async (url, init) => {
          const response = (await fetch(url, init)) as unknown as {
            ok: boolean
            status: number
            headers: { get(name: string): string | null }
            body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null
          }
          return response
        },
        run: async (cmd, args, timeout) => {
          const proc = Bun.spawn([cmd, ...args], { timeout })
          const stdout = await (
            new Response(proc.stdout as unknown as ReadableStream) as unknown as { text(): Promise<string> }
          ).text()
          const stderr = await (
            new Response(proc.stderr as unknown as ReadableStream) as unknown as { text(): Promise<string> }
          ).text()
          const code = await proc.exited
          return { stdout, stderr, code }
        },
        fs: {
          mkdir: async (path, _opts) => {
            await Bun.$`mkdir -p ${path}`.quiet()
          },
          rename: async (from, to) => {
            await Bun.$`mv ${from} ${to}`.quiet()
          },
          remove: async (path, _opts) => {
            await Bun.$`rm -rf ${path}`.quiet()
          },
          exists: async (path) => await Bun.file(path).exists(),
          readFile: async (path) => await Bun.file(path).text(),
          writeFile: async (path, data) => {
            await Bun.write(path, data)
          },
        },
        ulid: () => Bun.randomUUIDv7(),
        log: (level, message, data) => ctx.logger[level](message, data as Record<string, unknown> | undefined),
        report: (next) => {
          if (next.kind === 'downloading') setStatus(statusOf('downloading', next.progress))
          else setStatus(statusOf('installing'))
        },
        now: () => ctx.clock.now(),
      },
      toolsDir,
      pythonDir,
    )

    const setStatus = (next: typeof status): void => {
      status = next
      ctx.rpc.emit('python.statusChanged', status)
    }

    // 启动时清理残留 + 读标记文件（07 页 §13C 的 onReady 一行）
    ctx.lifecycle.onReady(async () => {
      await removeStagingLeftovers()

      const marker = await readMarker()
      const exe = path.join(pythonDir, 'python.exe')
      const plan = onReadyPlan({
        marker,
        exeExists: await Bun.file(exe).exists(),
        interpreter: await ctx.engine.settings.getPythonInterpreter().catch(() => null),
        pythonDir,
      })

      if (plan.ready && plan.exePath !== null) {
        setStatus(statusOf('ready', null, null, plan.exePath))
        await ctx.engine.settings.setPythonInterpreter(plan.exePath)
        return
      }
      setStatus(statusOf('absent'))
      if (plan.clearInterpreter) await ctx.engine.settings.setPythonInterpreter(null)
    })

    /** 上次没删干净的暂存 / 旧目录：启动时清掉（失败只记 warn，不挡启动）。 */
    async function removeStagingLeftovers(): Promise<void> {
      try {
        for await (const entry of new Bun.Glob('python.{staging,old}-*').scan({ cwd: toolsDir, onlyFiles: false })) {
          await Bun.$`rm -rf ${path.join(toolsDir, entry)}`.quiet()
          ctx.logger.warn('清理 Python 残留目录', { target: path.join(toolsDir, entry) })
        }
      } catch (e) {
        ctx.logger.warn('清理 Python 残留目录失败', { error: String(e) })
      }
    }

    async function readMarker(): Promise<unknown> {
      try {
        return JSON.parse(await Bun.file(markerPath).text()) as unknown
      } catch {
        return null
      }
    }

    ctx.rpc.handle('python.status', () => status)

    ctx.rpc.handle('python.install', async () => {
      if (status.state === 'downloading' || status.state === 'installing') {
        return status
      }
      if (status.state === 'ready') {
        return status
      }

      try {
        await installer.install()
        const exe = path.join(pythonDir, 'python.exe')
        setStatus(statusOf('ready', null, null, exe))
        await ctx.engine.settings.setPythonInterpreter(exe)
      } catch (e) {
        /*
         * 失败原因只从 AppError 的错误码取（铁律 5）：installer 抛什么就报什么，
         * 别的异常一律归 download_failed。不再从 message 里切前缀 —— 那要求
         * installer 把错误码写成正文，等于把错误码当字符串用。
         */
        const code = e instanceof AppError ? e.code : pythonErrors.download_failed
        const message = e instanceof AppError ? e.message : String(e)
        setStatus(statusOf('failed', null, { code, message }))
      }

      return status
    })

    ctx.rpc.handle('python.remove', async () => {
      if (status.state === 'downloading' || status.state === 'installing') {
        throw new AppError(pythonErrors.busy, '正在安装 Python，请稍候')
      }

      await ctx.engine.settings.setPythonInterpreter(null)
      try {
        await Bun.$`rm -rf ${pythonDir}`.quiet()
      } catch {
        /* 忽略 */
      }
      setStatus(statusOf('absent'))
      return {}
    })

    ctx.lifecycle.onShutdown(() => {
      installer.abort()
    })
  },
})
