import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { systemClock, withTimeout } from '@poietica/foundation'
import { createLogger, stderrJsonSink } from '@poietica/logging'
import { LineSplitter } from '@poietica/process-kit'
import { PROTOCOL_VERSION } from '@poietica/protocol'
import { RpcPeer } from '@poietica/rpc'
import { createChildProcessTransport } from '@poietica/rpc/stdio'
import { buildCoreLaunch, type DataLayout, dataLayout } from '@poietica/runtime-layout'

/**
 * 探针：不启动 Electron，直接运行编译出来的 exe，验证它本身是对的——包括隔离是否成立。
 * CI 每次都跑它。任何一步失败：打印 Core stderr 的最后 200 行，以退出码 1 退出；
 * 无论成功失败，最后都删除 fakeHome。
 */
const ROOT = path.resolve(import.meta.dir, '../../..')
const DIST = path.join(ROOT, 'apps/core/dist-probe')
const EXE = path.join(DIST, 'poietica-core.exe')

async function main(): Promise<void> {
  console.log('[probe] 1/5 构建探针版…')
  // 用 Bun.spawnSync 而不是 $：Windows 上 bun 是 .exe，$ 会把路径再包一层引号导致找不到
  const build = Bun.spawnSync([process.execPath, path.join(ROOT, 'apps/core/scripts/build.ts'), '--probe'], {
    cwd: ROOT,
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  if (build.exitCode !== 0) fail(`探针版构建失败（退出码 ${String(build.exitCode)}）`)
  if (!(await Bun.file(EXE).exists())) fail('构建没有产出 poietica-core.exe')

  /*
   * 临时的假用户目录：数据根设在 <fakeHome>/AppData/Roaming/Poietica 之下，
   * 这样 「数据根必须在用户目录之下」 的约束成立，同时可以从外面检查有没有漏出去的路径。
   *
   * 位置选在仓库根下的 `.probe-home/`（纯 ASCII、且在允许写入的工作区里）：本机 %TEMP% 的路径里带
   * 非 ASCII 用户名（C:\Users\<中文名>\AppData\Local\Temp），编译出来的 exe 在那里写普通文件会 EPERM，
   * bun:sqlite 随之报 "unable to open database file" —— 那是环境问题而不是 Core 的问题，但会让探针
   * 永远红。探针检查的是「隔离有没有漏」，与被测目录在哪无关，所以这个位置不影响结论。
   */
  const fakeHome = path.join(ROOT, '.probe-home')
  rmSync(fakeHome, { recursive: true, force: true })
  const dataRoot = path.join(fakeHome, 'AppData', 'Roaming', 'Poietica')
  const layout: DataLayout = dataLayout(dataRoot)
  // 目录必须在 spawn 之前建好：omp 打开 <agentDir>/agent.db 时不会自己建目录
  for (const dir of [
    layout.coreDir,
    layout.coreCwd,
    layout.ompAgentDir,
    path.join(layout.nativeHomeDir, 'omp'),
    layout.logsDir,
  ]) {
    mkdirSync(dir, { recursive: true })
    if (!existsSync(dir)) throw new Error(`目录没有建出来：${dir}`)
  }
  console.log(`[probe]     数据根 ${dataRoot}`)
  const stderrLines: string[] = []
  let child: ChildProcess | undefined

  try {
    console.log('[probe] 2/5 启动（假用户目录）…')
    // 与 Host 完全相同的启动规格；只额外补回 POIETICA_PROBE_BUILD 与 --probe-mock-model
    // （buildCoreLaunch 会剔除 POIETICA_* 前缀，探针版标记必须单独补回给子进程）
    const launch = envForCore(fakeHome, layout)
    const args = [
      'serve',
      '--data-root',
      dataRoot,
      '--log-level',
      'debug',
      '--relay-port',
      '45999',
      '--strict',
      '--probe-mock-model',
    ]
    // 用 node:child_process 而不是 Bun.spawn：createChildProcessTransport 面向 Node 风格的子进程流
    // （setEncoding / on('data')），这也是 CoreSupervisor 启动 Core 的同一条路径。
    child = nodeSpawn(EXE, args, {
      cwd: layout.coreCwd,
      env: { ...launch, POIETICA_PROBE_BUILD: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const transport = createChildProcessTransport(child, { onStray: (text) => stderrLines.push(text) })
    let ready: { coreVersion: string; protocolVersion: number; engineVersion: string } | undefined
    const peer = new RpcPeer({
      name: 'probe',
      transport,
      logger: createLogger({ level: 'error', sinks: [stderrJsonSink()] }),
      onNotification: (method, params) => {
        if (method === 'core.ready') ready = params as typeof ready
      },
    })

    console.log('[probe] 3/5 等待 core.ready（10 秒）…')
    // stderr 逐行收集（失败时打印最后 200 行）
    const lines = new LineSplitter((line) => {
      if (line.trim() !== '') stderrLines.push(line)
    })
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => lines.push(chunk))
    const pump = new Promise<void>((resolve) => {
      child?.once('exit', () => {
        lines.flush()
        resolve()
      })
    })

    const deadline = systemClock.now() + 10_000
    while (ready === undefined && systemClock.now() < deadline && child.exitCode === null) {
      await Bun.sleep(50)
    }
    if (ready === undefined) fail('10 秒内没有收到 core.ready')
    if (ready.protocolVersion !== PROTOCOL_VERSION) {
      fail(`协议版本不一致：Core ${ready.protocolVersion}，Host ${PROTOCOL_VERSION}`)
    }
    console.log(`[probe]     core.ready：coreVersion=${ready.coreVersion} engineVersion=${ready.engineVersion}`)

    console.log('[probe] 4/5 检查隔离目录与用户目录…')
    const check = await import('@poietica/engine-omp/bootstrap')
    void check
    // 隔离目录：所有 omp 目录都必须落在数据根之下（self-check 已通过才会 ready）；
    // 用户目录：除数据根路径链外，fakeHome 里不得出现任何文件或目录
    const leaked = listLeaks(fakeHome, dataRoot)
    if (leaked.length > 0) fail(`假用户目录里出现了数据根之外的路径：\n  ${leaked.join('\n  ')}`)
    console.log('[probe]     用户目录干净：除数据根路径链外没有任何文件或目录')

    console.log('[probe] 5/5 优雅退出…')
    const reply = await withTimeout(
      peer.request('core.shutdown', {}, { timeoutMs: 5_000 }),
      6_000,
      () => new Error('shutdown 超时'),
    )
    void reply
    const exitDeadline = systemClock.now() + 5_000
    while (child.exitCode === null && systemClock.now() < exitDeadline) await Bun.sleep(50)
    child.kill()
    await pump
    if (child.exitCode !== 0) fail(`退出码应为 0，实际是 ${String(child.exitCode)}`)
    peer.dispose()
    console.log('[probe] 全部通过 ✅')
  } finally {
    try {
      child?.kill()
    } catch {
      /* 已经退出 */
    }
    rmSync(fakeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }

  function fail(message: string): never {
    console.error(`[probe] ❌ ${message}`)
    if (stderrLines.length > 0) {
      console.error('[probe] Core stderr 的最后 200 行：')
      for (const line of stderrLines.slice(-200)) console.error(`  ${line}`)
    }
    process.exit(1)
  }
}

/** 与 buildCoreLaunch 的 env 规则一致（这里直接复用它的产物，只额外补 POIETICA_PROBE_BUILD） */
function envForCore(fakeHome: string, layout: DataLayout): Record<string, string> {
  const launch = buildCoreLaunch({
    coreExe: EXE,
    dataRoot: layout.root,
    homeDir: fakeHome,
    relayPort: 45999,
    logLevel: 'debug',
    strict: true,
    baseEnv: { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome },
  })
  return { ...launch.env }
}

/**
 * 假用户目录里除了**数据根这一条路径链**之外，不允许出现任何文件或目录。
 * 数据根里面的东西全部允许（那是它的本职），只有跑到它外面的才算泄漏。
 */
function listLeaks(fakeHome: string, dataRoot: string): string[] {
  const root = path.resolve(fakeHome)
  const data = path.resolve(dataRoot)
  // 数据根本身以及它到 fakeHome 的每一级祖父母录，都算这条路径链的一部分
  const chain = new Set<string>()
  let current = data
  while (current.startsWith(root)) {
    chain.add(current.toLowerCase())
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  const leaks: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.resolve(dir, entry.name).toLowerCase()
      // 数据根以下的一切都归数据根管
      if (full === data.toLowerCase() || full.startsWith(`${data.toLowerCase()}\\`)) continue
      if (chain.has(full)) {
        if (entry.isDirectory()) walk(path.join(dir, entry.name))
        continue
      }
      leaks.push(path.relative(root, path.join(dir, entry.name)))
    }
  }
  walk(root)
  return leaks
}

await main()
