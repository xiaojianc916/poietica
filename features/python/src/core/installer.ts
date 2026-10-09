import path from 'node:path'
import { AppError } from '@poietica/foundation'
import type { InstallMarker } from '../contract'
import { pythonErrors } from '../contract/errors'
import {
  DOWNLOAD_TIMEOUT_MS,
  PYTHON_ASSET_SHA256,
  PYTHON_DOWNLOAD_URLS,
  PYTHON_RELEASE_TAG,
  PYTHON_VERSION,
} from './release'

/** 下载进度回传的节流窗口（07 页 §13C 步骤 2：状态通知最多每 250ms 一次） */
export const PROGRESS_INTERVAL_MS = 250

/** 注入的依赖（测试时替换） */
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
    rename: (from: string, to: string) => Promise<void>
    remove: (path: string, opts?: { recursive?: boolean }) => Promise<void>
    exists: (path: string) => Promise<boolean>
    readFile: (path: string) => Promise<string>
    /** 文本与二进制都要能写（07 页 §13C 步骤 1：tar.gz 是字节流，不能当文本转一遍） */
    writeFile: (path: string, data: string | Uint8Array) => Promise<void>
  }
  readonly ulid: () => string
  readonly log: (level: 'info' | 'warn' | 'error', message: string, data?: Record<string, unknown>) => void
  /** 状态上报：下载进度（受 PROGRESS_INTERVAL_MS 节流）与阶段切换 */
  readonly report: (
    next: { readonly kind: 'downloading'; readonly progress: number } | { readonly kind: 'installing' },
  ) => void
  /** 现在（毫秒）；测试注入假时钟 */
  readonly now: () => number
  /** 期望的 sha256（07 页 §13C 步骤 3）；生产恒为 release.generated.ts 里钉住的那一个 */
  readonly expectedSha256?: string
}

export type InstallerState =
  | { kind: 'idle' }
  | { kind: 'downloading'; progress: number; abort: AbortController }
  | { kind: 'installing' }

export interface PythonInstaller {
  readonly state: InstallerState
  install(): Promise<void>
  abort(): void
}

export function createInstaller(deps: InstallerDeps, stagingDir: string, targetDir: string): PythonInstaller {
  let state: InstallerState = { kind: 'idle' }

  const setState = (next: InstallerState): void => {
    state = next
  }

  /*
   * 一条地址的下载结果：成功给字节，失败给错误码。
   *
   * 校验和不符与网络 / HTTP 失败是**两种**结局（07 页 §13C 步骤 3）：前者说明这一份
   * 内容被篡改或传坏了，后者说明这次没拿到。全失败时把最后一次的错误码报出去。
   */
  const fetchOnce = async (
    url: string,
    archive: string,
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

      /*
       * 先按字节攒齐再一次性写盘。**不能**走 `Blob.text()` / 字符串写盘 —— 那会把
       * tar.gz 按 UTF-8 重新编码，字节全变，解压必炸（07 页 §13C 步骤 1/6）。
       */
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
            deps.report({ kind: 'downloading', progress: received / total })
          }
        }
      }
      await deps.fs.writeFile(archive, joinChunks(chunks, received))

      const digest = hasher.digest('hex')
      const expected = deps.expectedSha256 ?? PYTHON_ASSET_SHA256
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

      const markerPath = path.join(targetDir, 'poietica-python.json')
      const staging = path.join(stagingDir, `python.staging-${deps.ulid()}`)
      const archive = path.join(staging, 'python.tar.gz')
      const abort = new AbortController()

      setState({ kind: 'downloading', progress: 0, abort })
      deps.report({ kind: 'downloading', progress: 0 })

      try {
        await deps.fs.mkdir(staging, { recursive: true })

        let last: { code: string; detail: string } | undefined
        for (const url of PYTHON_DOWNLOAD_URLS) {
          deps.log('info', `下载 Python：${url}`)
          const result = await fetchOnce(url, archive, abort)
          if (result.ok) {
            last = undefined
            break
          }
          last = { code: result.code, detail: result.detail }
          /* 07 页 §13C 步骤 3：校验不符的这一份不能留给下一个地址去覆盖（内容也不可信） */
          await deps.fs.remove(archive).catch(() => undefined)
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

        const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
        const extract = await deps.run(tar, ['-xzf', archive, '-C', staging], 120_000)
        if (extract.code !== 0) {
          throw new AppError(pythonErrors.extract_failed, 'Python 解压失败', { stderr: extract.stderr })
        }

        const exe = path.join(staging, 'python', 'python.exe')
        const verify = await deps.run(exe, ['-c', `import sys;print(sys.version.split()[0])`], 30_000)
        const version = verify.stdout.trim()
        if (version !== PYTHON_VERSION) {
          throw new AppError(pythonErrors.verify_failed, 'Python 安装后无法运行', {
            got: version,
            want: PYTHON_VERSION,
          })
        }

        if (await deps.fs.exists(targetDir)) {
          const old = path.join(stagingDir, `python.old-${deps.ulid()}`)
          await deps.fs.rename(targetDir, old)
          try {
            await deps.fs.remove(old, { recursive: true })
          } catch {
            deps.log('warn', '删除旧目录失败')
          }
        }
        await deps.fs.rename(path.join(staging, 'python'), targetDir)

        const marker: InstallMarker = {
          tag: PYTHON_RELEASE_TAG,
          version: PYTHON_VERSION,
          /* 记的是这一份安装**实际被校验通过**的那个哈希；生产恒等于产品钉住的那一个 */
          sha256: deps.expectedSha256 ?? PYTHON_ASSET_SHA256,
          installedAt: Date.now(),
        }
        await deps.fs.writeFile(markerPath, JSON.stringify(marker))

        try {
          await deps.fs.remove(staging, { recursive: true })
        } catch {
          deps.log('warn', '删除暂存目录失败')
        }

        setState({ kind: 'idle' })
      } catch (e) {
        try {
          await deps.fs.remove(staging, { recursive: true })
        } catch {
          /* 忽略 */
        }
        setState({ kind: 'idle' })
        throw e
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

/** 把下载分片拼成一整块（避免 `Uint8Array.concat` 逐块拷贝的平方开销）。 */
function joinChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) {
    out.set(chunk, at)
    at += chunk.length
  }
  return out
}
