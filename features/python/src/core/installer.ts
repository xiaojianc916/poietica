import path from 'node:path'
import { AppError } from '@poietica/foundation'
import { pythonErrors } from '../contract/errors'
import {
  DOWNLOAD_TIMEOUT_MS,
  INSTALL_TIMEOUT_MS,
  PYTHON_DOWNLOAD_URLS,
  PYTHON_INSTALLER,
  PYTHON_INSTALLER_SHA256,
} from './release'

/** 状态通知最多每 250ms 一次 */
export const PROGRESS_INTERVAL_MS = 250

/* 官方安装器的静默参数：装到当前用户（默认位置、不弹 UAC），写进用户 PATH；launcher 也装当前用户，
 * 否则安装器会为了「所有用户的 launcher」提权。 */
const INSTALL_ARGS: readonly string[] = [
  '/quiet',
  'InstallAllUsers=0',
  'PrependPath=1',
  'Include_test=0',
  'Include_launcher=1',
  'InstallLauncherAllUsers=0',
]

export interface InstallerDeps {
  readonly fetch: (
    url: string,
    init?: { signal?: AbortSignal },
  ) => Promise<{
    ok: boolean
    status: number
    headers: { get(name: string): string | null }
    body: { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } } | null
  }>
  readonly run: (
    cmd: string,
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ stdout: string; stderr: string; code: number }>
  readonly fs: {
    mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<void>
    remove: (path: string, opts?: { recursive?: boolean }) => Promise<void>
    /** 文本与二进制都要能写（安装包是字节流，不能当文本转一遍） */
    writeFile: (path: string, data: string | Uint8Array) => Promise<void>
  }
  readonly ulid: () => string
  readonly log: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
  /** 下载进度（受 PROGRESS_INTERVAL_MS 节流）与阶段切换 */
  readonly report: (
    next: { readonly kind: 'downloading'; readonly progress: number } | { readonly kind: 'installing' },
  ) => void
  readonly now: () => number
  /** 生产恒为 release.generated.ts 里钉住的那一个 */
  readonly expectedSha256?: string
}

export type InstallerState =
  { kind: 'idle' } | { kind: 'downloading'; progress: number; abort: AbortController } | { kind: 'installing' }

export interface PythonInstaller {
  readonly state: InstallerState
  install(): Promise<void>
  abort(): void
}

export function createInstaller(deps: InstallerDeps, stagingDir: string): PythonInstaller {
  let state: InstallerState = { kind: 'idle' }

  const setState = (next: InstallerState): void => {
    state = next
  }

  /* 一条地址的下载结果：成功给字节，失败给错误码。校验和不符与网络 / HTTP 失败是**两种**结局：前者说明这一份内容被篡改或传坏了，后者说明这次
   * 没拿到。全失败时把最后一次的错误码报出去。 */
  const fetchOnce = async (
    url: string,
    installer: string,
    abort: AbortController,
  ): Promise<{ ok: true } | { ok: false; code: string; detail: string }> => {
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])
    let received = 0
    let lastTick = deps.now()
    try {
      const response = await deps.fetch(url, { signal })
      if (!response.ok) return { ok: false, code: pythonErrors.download_failed, detail: `HTTP ${response.status}` }

      const total = Number(response.headers.get('content-length') ?? 0)
      const reader = response.body?.getReader()
      if (reader === undefined) return { ok: false, code: pythonErrors.download_failed, detail: 'no response body' }

      /* 先按字节攒齐再一次性写盘。**不能**走 `Blob.text()` / 字符串写盘 —— 那会把 exe 按 UTF-8 重新编码，字节全变，装不上。 */
      const hasher = new Bun.CryptoHasher('sha256')
      const chunks: Uint8Array[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value === undefined) continue
        chunks.push(value)
        hasher.update(value)
        received += value.length
        if (total > 0) {
          const now = deps.now()
          if (now - lastTick >= PROGRESS_INTERVAL_MS) {
            lastTick = now
            deps.report({ kind: 'downloading', progress: Math.min(1, received / total) })
          }
        }
      }
      await deps.fs.writeFile(installer, joinChunks(chunks, received))

      const digest = hasher.digest('hex')
      const expected = deps.expectedSha256 ?? PYTHON_INSTALLER_SHA256
      if (digest !== expected) {
        deps.log('warn', `校验和不匹配：${digest} ≠ ${expected}`, { url })
        return { ok: false, code: pythonErrors.checksum_mismatch, detail: digest }
      }
      return { ok: true }
    } catch (e) {
      if (abort.signal.aborted) throw e // 用户取消：交给外层
      deps.log('warn', `下载失败：${url}`, { error: String(e) })
      return { ok: false, code: pythonErrors.download_failed, detail: String(e) }
    }
  }

  return {
    get state() {
      return state
    },
    async install(): Promise<void> {
      if (state.kind !== 'idle') return

      const staging = path.join(stagingDir, `python-setup-${deps.ulid()}`)
      const installer = path.join(staging, PYTHON_INSTALLER)
      const abort = new AbortController()

      /* 状态必须在第一个 await 之前切到 downloading：否则并发进来的第二次 install 会看到 idle，
       * 再开一份下载（旧实现就是在这里先 await mkdir 的）。 */
      setState({ kind: 'downloading', progress: 0, abort })
      deps.report({ kind: 'downloading', progress: 0 })

      try {
        await deps.fs.mkdir(staging, { recursive: true })

        let last: { code: string; detail: string } | undefined
        for (const url of PYTHON_DOWNLOAD_URLS) {
          deps.log('info', `下载 Python 安装包：${url}`)
          const result = await fetchOnce(url, installer, abort)
          if (result.ok) {
            last = undefined
            break
          }
          last = { code: result.code, detail: result.detail }
          /* 校验不符的这一份不能留给下一个地址去覆盖（内容也不可信）。 */
          await deps.fs.remove(installer).catch(() => undefined)
        }

        if (last !== undefined) {
          throw new AppError(
            last.code,
            last.code === pythonErrors.checksum_mismatch
              ? '下载的 Python 文件校验失败'
              : 'Python 下载失败，请检查网络后重试',
            { detail: last.detail },
          )
        }

        setState({ kind: 'installing' })
        deps.report({ kind: 'installing' })

        const result = await deps.run(installer, INSTALL_ARGS, INSTALL_TIMEOUT_MS)
        /* 3010 = 安装成功但要重启；Python 安装器实际不会要求，预留只为了避免把成功报成失败。 */
        if (result.code !== 0 && result.code !== 3010) {
          deps.log('error', 'Python 安装器失败', { code: result.code, stderr: result.stderr.slice(0, 2000) })
          throw new AppError(pythonErrors.install_failed, `安装器退出码 ${result.code}`, { exitCode: result.code })
        }
        setState({ kind: 'idle' })
      } catch (e) {
        setState({ kind: 'idle' })
        throw e
      } finally {
        try {
          await deps.fs.remove(staging, { recursive: true })
        } catch {
          deps.log('warn', '删除 Python 安装暂存目录失败')
        }
      }
    },
    abort(): void {
      if (state.kind === 'downloading') {
        state.abort.abort()
        setState({ kind: 'idle' })
      }
    },
  }
}

/** 交给 Bun 的官方实现，不自己逐块拷贝。 */
function joinChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  return Bun.concatArrayBuffers([...chunks], total, true)
}
