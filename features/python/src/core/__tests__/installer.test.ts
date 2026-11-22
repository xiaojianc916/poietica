import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { pythonErrors } from '../../contract/errors'
import { createInstaller, type InstallerDeps } from '../installer'
import { PYTHON_INSTALLER } from '../release'

/* 注入假 fetch / 假 run / 假 fs 与临时目录。这里**不碰真网络、不跑安装器**：验证的是编排（地址轮换、校验和语义、
 * 静默参数、失败分类、残留清理、幂等），真实安装包由 python:pin 在发布链上验证。 */

interface FakeFs {
  readonly files: Map<string, string | Uint8Array>
  readonly dirs: Set<string>
}

function fakeDeps(overrides: Partial<InstallerDeps> = {}): {
  deps: InstallerDeps
  calls: string[]
  statuses: string[]
  fs: FakeFs
} {
  const fs: FakeFs = { files: new Map(), dirs: new Set() }
  const calls: string[] = []
  const statuses: string[] = []
  const deps: InstallerDeps = {
    expectedSha256: SHA_OK,
    fetch: async (url) => {
      calls.push(`fetch:${url}`)
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(FAKE_PAYLOAD.length) },
        body: { getReader: () => readerOf([FAKE_PAYLOAD]) },
      }
    },
    run: async (cmd, args) => {
      calls.push(`run:${cmd} ${args.join(' ')}`)
      return { stdout: '', stderr: '', code: 0 }
    },
    fs: {
      mkdir: async (target) => {
        fs.dirs.add(target)
      },
      remove: async (target) => {
        for (const file of [...fs.files.keys()]) {
          if (file === target || file.startsWith(`${target}\\`) || file.startsWith(`${target}/`)) {
            fs.files.delete(file)
          }
        }
        for (const dir of [...fs.dirs]) {
          if (dir === target || dir.startsWith(`${target}\\`) || dir.startsWith(`${target}/`)) fs.dirs.delete(dir)
        }
      },
      writeFile: async (target, data) => {
        fs.files.set(target, data)
      },
    },
    ulid: () => 'T1',
    log: () => undefined,
    report: (next) => {
      statuses.push(next.kind)
    },
    now: () => 0,
    ...overrides,
  }
  return { deps, calls, statuses, fs }
}

function readerOf(chunks: Uint8Array[]): { read(): Promise<{ done: boolean; value?: Uint8Array }> } {
  let at = 0
  return {
    async read() {
      const value = chunks[at++]
      return value === undefined ? { done: true } : { done: false, value }
    },
  }
}

const shaOf = (bytes: Uint8Array): string => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')

/* 假内容与它的真哈希：期望的 sha 由测试注入（生产恒为 release.generated.ts 里钉住的 PYTHON_INSTALLER_SHA256），
 * 所以这里能拿一小段假 payload 走完真实的校验路径。 */
const FAKE_PAYLOAD = new TextEncoder().encode('fake-python-installer')
const SHA_OK = shaOf(FAKE_PAYLOAD)
const SHA_WRONG = 'b'.repeat(64)

describe('PY-1 下载：第一个地址失败、第二个成功', () => {
  test('第一个 503 被跳过，第二个地址成功后真跑安装器，并报出 downloading / installing', async () => {
    const { deps, calls, statuses, fs } = fakeDeps({
      fetch: async (url) => {
        calls.push(`fetch:${url}`)
        if (url.includes('npmmirror')) {
          return { ok: false, status: 503, headers: { get: () => null }, body: null }
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => String(FAKE_PAYLOAD.length) },
          body: { getReader: () => readerOf([FAKE_PAYLOAD]) },
        }
      },
    })

    const installer = createInstaller(deps, 'C:\\tools')
    await installer.install()

    expect(statuses[0]).toBe('downloading')
    expect(statuses).toContain('installing')
    /* 安装器只跑一次，参数是「当前用户 + 默认位置 + 写 PATH」，不提权装给所有用户。 */
    const run = calls.find((call) => call.startsWith('run:'))
    expect(run).toBeDefined()
    expect(run).toContain(PYTHON_INSTALLER)
    expect(run).toContain('/quiet')
    expect(run).toContain('InstallAllUsers=0')
    expect(run).toContain('PrependPath=1')
    expect(run).toContain('InstallLauncherAllUsers=0')
    /* 暂存目录连同安装包一起清掉。 */
    expect([...fs.dirs].some((dir) => dir.includes('python-setup-'))).toBe(false)
    expect([...fs.files.keys()].some((file) => file.includes('python-setup-'))).toBe(false)
  })
})

describe('PY-2 两个地址的校验和都不对', () => {
  test('错误码是 checksum_mismatch，且暂存目录被删除', async () => {
    const { deps, fs } = fakeDeps({ expectedSha256: SHA_WRONG })
    const installer = createInstaller(deps, 'C:\\tools')

    const error = await installer.install().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(pythonErrors.checksum_mismatch)
    expect([...fs.files.keys()].some((file) => file.includes('python-setup-'))).toBe(false)
    expect([...fs.dirs].some((dir) => dir.includes('python-setup-'))).toBe(false)
  })
})

describe('PY-3 下载中再次 install', () => {
  test('第二次 install 直接返回，不开始第二次下载', async () => {
    let fetches = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const { deps } = fakeDeps({
      fetch: async () => {
        fetches += 1
        await gate
        return {
          ok: true,
          status: 200,
          headers: { get: () => String(FAKE_PAYLOAD.length) },
          body: { getReader: () => readerOf([FAKE_PAYLOAD]) },
        }
      },
    })

    const installer = createInstaller(deps, 'C:\\tools')
    const first = installer.install()
    await Bun.sleep(0)
    await installer.install() // 幂等：还在 downloading
    release?.()
    await first
    expect(fetches).toBe(1)
  })
})

describe('安装器失败', () => {
  test('退出码非 0 → install_failed，错误里带退出码，暂存目录仍然清掉', async () => {
    const { deps, fs } = fakeDeps({
      run: async () => ({ stdout: '', stderr: 'boom', code: 1603 }),
    })

    const installer = createInstaller(deps, 'C:\\tools')
    const error = await installer.install().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(pythonErrors.install_failed)
    expect((error as AppError).data?.exitCode).toBe(1603)
    expect([...fs.dirs].some((dir) => dir.includes('python-setup-'))).toBe(false)
  })

  test('退出码 3010（成功后要求重启）按成功处理', async () => {
    const { deps } = fakeDeps({
      run: async () => ({ stdout: '', stderr: '', code: 3010 }),
    })

    const installer = createInstaller(deps, 'C:\\tools')
    await installer.install()
  })
})

describe('下载字节原样落盘', () => {
  test('安装包拿到的是原字节（不是重新编码过的字符串）', async () => {
    const written: (string | Uint8Array)[] = []
    const base = fakeDeps()
    const original = base.deps.fs.writeFile
    const spied: InstallerDeps = {
      ...base.deps,
      fs: {
        ...base.deps.fs,
        writeFile: async (target, data) => {
          if (target.endsWith(PYTHON_INSTALLER)) written.push(data)
          await original(target, data)
        },
      },
    }

    const installer = createInstaller(spied, 'C:\\tools')
    await installer.install()
    expect(written.length).toBe(1)
    expect(written[0]).toBeInstanceOf(Uint8Array)
    expect([...(written[0] as Uint8Array)]).toEqual([...FAKE_PAYLOAD])
  })
})
