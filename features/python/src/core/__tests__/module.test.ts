import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCoreHarness } from '@poietica/core-kernel/testing'
import { createFakeEngine } from '@poietica/runtime-protocol-testkit'
import { pythonContract } from '../../contract'
import { createPythonModule, type PythonModuleOverrides, removeLegacyInstallFiles } from '../index'
import { PYTHON_INSTALLER } from '../release'

const NEW_PYTHON = 'C:\\Python315\\python.exe'
const OLD_PYTHON = 'C:\\Python39\\python.exe'
const VENV = 'C:\\venv\\Scripts\\python.exe'

interface World {
  installed: boolean
  candidates: Map<string, string>
  registry: string
}

function world(): World {
  return { installed: false, candidates: new Map(), registry: '' }
}

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const ok = (stdout: string): { stdout: string; stderr: string; code: number } => ({ stdout, stderr: '', code: 0 })

function detectionOf(world: World): NonNullable<PythonModuleOverrides['detection']> {
  return {
    run: async (cmd, args) => {
      if (cmd.toLowerCase().endsWith('powershell.exe')) {
        return { stdout: bytes(world.registry), stderr: new Uint8Array(), code: 0 }
      }
      if (args[0] === '-X') {
        const version = world.installed ? world.candidates.get(cmd) : undefined
        return version === undefined
          ? { stdout: new Uint8Array(), stderr: bytes('boom'), code: 1 }
          : { stdout: bytes(`${version}\n${cmd}`), stderr: new Uint8Array(), code: 0 }
      }
      return { stdout: new Uint8Array(), stderr: new Uint8Array(), code: 1 }
    },
    exists: async (candidate) =>
      world.installed && (candidate === NEW_PYTHON || candidate === OLD_PYTHON || candidate === VENV),
    readdir: async () => [],
    which: async () => null,
    env: {
      WINDIR: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      PATH: '',
      ProgramFiles: 'C:\\Program Files',
    },
  }
}

const INSTALLER_PAYLOAD = new TextEncoder().encode('fake-python-installer')
const INSTALLER_SHA = new Bun.CryptoHasher('sha256').update(INSTALLER_PAYLOAD).digest('hex')

function installerOf(
  world: World,
  options: { readonly failDownload?: boolean; readonly verify?: boolean } = {},
): NonNullable<PythonModuleOverrides['installer']> {
  return {
    fetch: async () => {
      if (options.failDownload === true) throw new TypeError('network down')
      return {
        ok: true,
        status: 200,
        headers: { get: () => String(INSTALLER_PAYLOAD.length) },
        body: { getReader: () => readerOf([INSTALLER_PAYLOAD]) },
      }
    },
    run: async (cmd) => {
      if (cmd.endsWith(PYTHON_INSTALLER) && options.verify !== false) {
        world.installed = true
        world.registry = `${NEW_PYTHON}\r\n`
        world.candidates.set(NEW_PYTHON, '3.15.2')
      }
      return ok('')
    },
    fs: {
      mkdir: async () => undefined,
      remove: async () => undefined,
      writeFile: async () => undefined,
    },
    ulid: () => 'T1',
    expectedSha256: INSTALLER_SHA,
  }
}

function moduleOf(world: World, options: { readonly failDownload?: boolean; readonly verify?: boolean } = {}) {
  return createPythonModule({ detection: detectionOf(world), installer: installerOf(world, options) })
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

describe('python core onReady', () => {
  test('没有可用 Python → absent，且不写解释器设置', async () => {
    const engine = createFakeEngine()
    const h = await createCoreHarness({ modules: [moduleOf(world())], engine })
    const api = h.client(pythonContract)

    const status = await api.call('python.status', {})
    expect(status).toMatchObject({ state: 'absent', version: null, interpreter: null, error: null })
    expect(engine.pythonInterpreterCalls.length).toBe(0)

    await h.dispose()
  })

  test('系统里已有达标的 Python → ready，并把它写进 python.interpreter', async () => {
    const input = world()
    input.installed = true
    input.registry = `${NEW_PYTHON}\r\n`
    input.candidates.set(NEW_PYTHON, '3.15.2')

    const engine = createFakeEngine()
    const h = await createCoreHarness({ modules: [moduleOf(input)], engine })
    const status = await h.client(pythonContract).call('python.status', {})

    expect(status).toMatchObject({ state: 'ready', version: '3.15.2', interpreter: NEW_PYTHON })
    expect(engine.pythonInterpreterCalls).toContain(NEW_PYTHON)
    expect(engine.pythonInterpreterCalls.at(-1)).toBe(NEW_PYTHON)

    await h.dispose()
  })

  test('系统 Python 版本过低 → outdated，按钮仍是安装', async () => {
    const input = world()
    input.installed = true
    input.registry = `${OLD_PYTHON}\r\n`
    input.candidates.set(OLD_PYTHON, '3.9.13')

    const engine = createFakeEngine()
    const h = await createCoreHarness({ modules: [moduleOf(input)], engine })
    const status = await h.client(pythonContract).call('python.status', {})

    expect(status).toMatchObject({ state: 'outdated', version: '3.9.13', interpreter: OLD_PYTHON })

    await h.dispose()
  })

  test('已经配置好的解释器（venv）达标时不被系统新版本顶掉', async () => {
    const input = world()
    input.installed = true
    input.registry = `${NEW_PYTHON}\r\n`
    input.candidates.set(NEW_PYTHON, '3.15.2')
    input.candidates.set(VENV, '3.12.8')

    const engine = createFakeEngine()
    await engine.settings.setPythonInterpreter(VENV)
    const h = await createCoreHarness({ modules: [moduleOf(input)], engine })
    const status = await h.client(pythonContract).call('python.status', {})

    expect(status).toMatchObject({ state: 'ready', version: '3.12.8', interpreter: VENV })
    /* 选的还是原来那一格：没有发生第二次写入。 */
    expect(engine.pythonInterpreterCalls).toEqual([VENV])

    await h.dispose()
  })

  test('启动时的 onReady 会把状态推给订阅者（python.statusChanged 至少一条）', async () => {
    const h = await createCoreHarness({ modules: [moduleOf(world())], engine: createFakeEngine() })
    const changes = h.notifications(pythonContract, 'python.statusChanged')
    expect(changes.length).toBeGreaterThan(0)
    expect(changes.at(-1)?.state).toBe('absent')
    await h.dispose()
  })

  test('桥接把空值折成对象时也按「没设置」处理，不崩', async () => {
    /* 线上真出过：ARP 的 engineCall 用 `?? {}` 把 getPythonInterpreter 的 null 过桥成 {}，
     * 这里读回来的东西不再是 string | null，后面 path.resolve / toLowerCase 会直接抛。 */
    const base = createFakeEngine()
    const engine = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'settings') {
          return { ...target.settings, getPythonInterpreter: async () => ({}) as never }
        }
        return Reflect.get(target, prop, receiver)
      },
    })

    const h = await createCoreHarness({ modules: [moduleOf(world())], engine })
    const status = await h.client(pythonContract).call('python.status', {})
    expect(status.state).toBe('absent')
    await h.dispose()
  })
})

describe('python core 安装 / 升级', () => {
  test('没有 Python 时点安装 → 装完 ready，并指向新装的那一个', async () => {
    const input = world()
    const engine = createFakeEngine()
    const h = await createCoreHarness({ modules: [moduleOf(input)], engine })
    const api = h.client(pythonContract)

    const status = await api.call('python.install', {})
    expect(status).toMatchObject({ state: 'ready', version: '3.15.2', interpreter: NEW_PYTHON })
    expect(engine.pythonInterpreterCalls.at(-1)).toBe(NEW_PYTHON)

    await h.dispose()
  })

  test('已经 ready 时再点安装 → 直接返回，不再下载', async () => {
    const input = world()
    input.installed = true
    input.registry = `${NEW_PYTHON}\r\n`
    input.candidates.set(NEW_PYTHON, '3.15.2')

    const engine = createFakeEngine()
    const h = await createCoreHarness({
      modules: [
        createPythonModule({
          detection: detectionOf(input),
          installer: {
            ...installerOf(input),
            fetch: async () => {
              throw new Error('ready 之后不该再下载')
            },
          },
        }),
      ],
      engine,
    })

    const status = await h.client(pythonContract).call('python.install', {})
    expect(status.state).toBe('ready')

    await h.dispose()
  })

  test('下载拿不到 → failed，码是 download_failed，且不写解释器设置', async () => {
    const engine = createFakeEngine()
    const h = await createCoreHarness({ modules: [moduleOf(world(), { failDownload: true })], engine })
    const api = h.client(pythonContract)

    const status = await api.call('python.install', {})
    expect(status.state).toBe('failed')
    expect(status.error?.code).toBe('python.download_failed')
    /* 只有走到 ready 才允许写 `python.interpreter`；失败的一次不许把设置指到一个不存在的 exe 上。 */
    expect(engine.pythonInterpreterCalls.length).toBe(0)

    await h.dispose()
  })

  test('安装器说成功、但装完探测不到 → failed，码是 verify_failed', async () => {
    const engine = createFakeEngine()
    const h = await createCoreHarness({ modules: [moduleOf(world(), { verify: false })], engine })
    const api = h.client(pythonContract)

    const status = await api.call('python.install', {})
    expect(status.state).toBe('failed')
    expect(status.error?.code).toBe('python.verify_failed')

    await h.dispose()
  })

  test('安装器说成功、但探测到的还是旧版本 → 不报 ready', async () => {
    const input = world()
    input.installed = true
    input.registry = `${OLD_PYTHON}\r\n`
    input.candidates.set(OLD_PYTHON, '3.10.14')

    const engine = createFakeEngine()
    const h = await createCoreHarness({
      modules: [
        createPythonModule({ detection: detectionOf(input), installer: installerOf(input, { verify: false }) }),
      ],
      engine,
    })
    const api = h.client(pythonContract)

    const status = await api.call('python.install', {})
    expect(status.state).toBe('failed')
    expect(status.error?.code).toBe('python.verify_failed')

    await h.dispose()
  })
})

describe('旧版内置目录清理', () => {
  test('删掉 tools/python 与 python-setup-* 残留', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'poietica-python-cleanup-'))
    try {
      const tools = path.join(root, 'tools')
      const pythonDir = path.join(tools, 'python')
      const staging = path.join(tools, 'python-setup-old')
      await mkdir(pythonDir, { recursive: true })
      await mkdir(staging, { recursive: true })
      await writeFile(path.join(pythonDir, 'python.exe'), 'old')
      await writeFile(path.join(staging, 'python-3.15.2-amd64.exe'), 'old')

      const logs: string[] = []
      await removeLegacyInstallFiles({
        pythonDir,
        toolsDir: tools,
        log: (_level, message) => {
          logs.push(message)
        },
      })

      await expect(stat(pythonDir)).rejects.toThrow()
      await expect(stat(staging)).rejects.toThrow()
      expect(logs).toContain('已清理旧版内置 Python 目录')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
