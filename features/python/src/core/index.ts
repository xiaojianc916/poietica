import { mkdir, rename, rm } from 'node:fs/promises'
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
          /*
           * stderr 显式 pipe：Bun.spawn 默认 inherit，流上是 undefined ——
           * 从前那句 `new Response(proc.stderr)` 读到的永远是空串，失败详情全丢了。
           */
          const proc = Bun.spawn([cmd, ...args], { timeout, stderr: 'pipe' })
          /* 读取交给 Bun 官方实现，不自己把流包进 Response 再取 text */
          const stdout = await Bun.readableStreamToText(proc.stdout)
          const stderr = await Bun.readableStreamToText(proc.stderr)
          const code = await proc.exited
          return { stdout, stderr, code }
        },
        fs: {
          /* 文件操作走 node:fs 的官方实现，不经 shell 命令 */
          mkdir: async (path, opts) => {
            await mkdir(path, { recursive: opts?.recursive ?? false })
          },
          rename: (from, to) => rename(from, to),
          remove: (path, opts) => rm(path, { recursive: opts?.recursive ?? false, force: true }),
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
          await rm(path.join(toolsDir, entry), { recursive: true, force: true })
          ctx.logger.warn('清理 Python 残留目录', { target: path.join(toolsDir, entry) })
        }
      } catch (e) {
        ctx.logger.warn('清理 Python 残留目录失败', { error: String(e) })
      }
    }

    async function readMarker(): Promise<unknown> {
      try {
        /* Bun 自带的 json() 解析，别在这里再手搓 text + JSON.parse */
        return await Bun.file(markerPath).json()
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
        await rm(pythonDir, { recursive: true, force: true })
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
