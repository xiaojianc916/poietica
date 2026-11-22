import { describe, expect, test } from 'bun:test'
import {
  type CommandBytes,
  compareVersions,
  type DetectionDeps,
  detectPython,
  parseLauncherOutput,
  parseRegistryOutput,
  parseVersion,
} from '../detect'

const LEGACY = 'C:\\Users\\u\\AppData\\Roaming\\Poietica\\tools\\python'
const PY = 'C:\\Windows\\py.exe'

interface World {
  readonly files: Set<string>
  readonly listings: Map<string, readonly string[]>
  readonly versions: Map<string, string>
  launcher: string
  registry: string
  py: string | null
}

function world(): World {
  return { files: new Set(), listings: new Map(), versions: new Map(), launcher: '', registry: '', py: PY }
}

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const ok = (stdout: string): CommandBytes => ({ stdout: bytes(stdout), stderr: new Uint8Array(), code: 0 })
const failed = (): CommandBytes => ({ stdout: new Uint8Array(), stderr: bytes('boom'), code: 1 })

function depsOf(input: World, overrides: Partial<DetectionDeps> = {}): DetectionDeps {
  return {
    run: async (cmd, args) => {
      if (input.py !== null && cmd === input.py && args[0] === '-0p') return ok(input.launcher)
      if (cmd.toLowerCase().endsWith('powershell.exe')) return ok(input.registry)
      if (args[0] === '-X') {
        const version = input.versions.get(cmd)
        return version === undefined ? failed() : ok(`${version}\n${cmd}`)
      }
      return failed()
    },
    exists: async (candidate) => input.files.has(candidate) || input.listings.has(candidate),
    readdir: async (dir) => input.listings.get(dir) ?? [],
    which: async () => input.py,
    env: {
      WINDIR: 'C:\\Windows',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      PATH: '',
      ProgramFiles: 'C:\\Program Files',
    },
    legacyDir: LEGACY,
    current: null,
    log: () => undefined,
    ...overrides,
  }
}

function addPython(input: World, candidate: string, version: string): void {
  input.files.add(candidate)
  input.versions.set(candidate, version)
}

describe('版本比较', () => {
  test('数字逐段比较；3.15 与 3.15.0 相等，rc 后缀按补丁号算', () => {
    expect(compareVersions('3.15.2', '3.15.10')).toBeLessThan(0)
    expect(compareVersions('3.15', '3.15.0')).toBe(0)
    expect(compareVersions('3.16.0rc1', '3.15.9')).toBeGreaterThan(0)
    expect(compareVersions('nonsense', '3.11.0')).toBeLessThan(0)
  })

  test('parseVersion 取前缀', () => {
    expect(parseVersion('3.15.2')).toEqual([3, 15, 2])
    expect(parseVersion('3.15')).toEqual([3, 15, 0])
    expect(parseVersion('Python 3.15')).toBeNull()
  })
})

describe('启动器 / 注册表输出解析', () => {
  test('py -0p：星号、带空格的引号路径、Astral 标记', () => {
    const entries = parseLauncherOutput(
      [
        ' -V:3.15.2 *        "C:\\Program Files\\Python 3.15\\python.exe"',
        ' -V:Astral\\CPython3.16.0 C:\\Users\\u\\AppData\\Roaming\\uv\\python\\cpython-3.16.0\\python.exe',
        ' not a launcher line',
      ].join('\r\n'),
    )

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({
      path: 'C:\\Program Files\\Python 3.15\\python.exe',
      default: true,
      managed: false,
    })
    expect(entries[1]).toMatchObject({ managed: true, default: false })
  })

  test('注册表输出只留 python.exe 行', () => {
    expect(parseRegistryOutput('C:\\Python315\\python.exe\r\n错误: 找不到\r\n\r\n')).toEqual([
      'C:\\Python315\\python.exe',
    ])
  })
})

describe('探测本机 Python', () => {
  test('只用正常安装；uv 管的版本不算系统 Python；WindowsApps 桩与旧内置目录都跳过', async () => {
    const input = world()
    addPython(input, PY, '')
    input.launcher = [
      ' -V:3.14 *        C:\\Python314\\python.exe',
      ' -V:3.15.2        C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python315\\python.exe',
      ' -V:Astral\\CPython3.16.0 C:\\Users\\u\\AppData\\Roaming\\uv\\python\\cpython-3.16.0\\python.exe',
      ` -V:2.7           ${LEGACY}\\python.exe`,
    ].join('\r\n')
    addPython(input, 'C:\\Python314\\python.exe', '3.14.0')
    addPython(input, 'C:\\Users\\u\\AppData\\Local\\Programs\\Python\\Python315\\python.exe', '3.15.2')
    addPython(input, 'C:\\Users\\u\\AppData\\Roaming\\uv\\python\\cpython-3.16.0\\python.exe', '3.16.0')
    addPython(input, `${LEGACY}\\python.exe`, '2.7.18')

    const stub = 'C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'
    addPython(input, stub, '3.15.2')
    input.listings.set('C:\\Users\\u\\AppData\\Local\\Programs\\Python', ['Python315'])

    const candidates = await detectPython(
      depsOf(input, {
        env: {
          WINDIR: 'C:\\Windows',
          LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
          PATH: `C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python314`,
          ProgramFiles: 'C:\\Program Files',
        },
      }),
    )

    expect(candidates.map((candidate) => candidate.version)).toEqual(['3.15.2', '3.14.0'])
    expect(candidates.every((candidate) => !candidate.managed)).toBe(true)
    expect(candidates.some((candidate) => candidate.path === stub)).toBe(false)
    expect(candidates.some((candidate) => candidate.path.startsWith(LEGACY))).toBe(false)
  })

  test('只有 uv 管的 Python 时不算「系统里装了 Python」', async () => {
    const input = world()
    addPython(input, PY, '')
    const managed = 'C:\\Users\\u\\AppData\\Roaming\\uv\\python\\cpython-3.15.2\\python.exe'
    input.launcher = ` -V:Astral\\CPython3.15.2 ${managed}`
    addPython(input, managed, '3.15.2')

    expect(await detectPython(depsOf(input))).toEqual([])
  })

  test('起不来的候选（注册表里的卸载残留）被跳过', async () => {
    const input = world()
    addPython(input, PY, '')
    input.launcher = [
      ' -V:3.13           C:\\Python313\\python.exe',
      ' -V:3.14 *        C:\\Python314\\python.exe',
    ].join('\r\n')
    input.files.add('C:\\Python313\\python.exe')
    addPython(input, 'C:\\Python314\\python.exe', '3.14.0')

    const candidates = await detectPython(depsOf(input))
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ path: 'C:\\Python314\\python.exe', version: '3.14.0' })
  })

  test('没有 py 启动器时从注册表兜底', async () => {
    const input = world()
    input.py = null
    input.registry = 'C:\\Python315\\python.exe\r\n'
    addPython(input, 'C:\\Python315\\python.exe', '3.15.2')

    const candidates = await detectPython(depsOf(input))
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ path: 'C:\\Python315\\python.exe', source: 'registry' })
  })

  test('已配置的解释器参与验证，并采用 sys.executable 报告的真实路径', async () => {
    const input = world()
    input.py = null
    const venv = 'C:\\venv\\Scripts\\python.exe'
    const real = 'C:\\Python315\\python.exe'
    input.files.add(venv)
    addPython(input, real, '3.15.2')
    input.versions.set(venv, '3.15.2')
    /* 让 venv 的探测输出报告 real：模拟 venv 的 sys.executable。 */
    const base = depsOf(input, { current: venv })
    const run = base.run
    const candidates = await detectPython({
      ...base,
      run: async (cmd, args, timeout) => {
        if (cmd === venv) return ok(`3.15.2\n${real}`)
        return run(cmd, args, timeout)
      },
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ path: real, version: '3.15.2', source: 'current' })
  })
})
