/*
 * 不启 GUI 的自检：只把原生库当普通 Node 插件加载，走一遍真实的 invoke 往返。
 * 它的产物就是 stdout 上那一行 smoke ok，console 在这里是输出而不是日志。
 *
 * 为什么把 poietica.dll 改名成 poietica.node：cargo 在 Windows 上把 cdylib 产出成 .dll，
 * 而 Node 只按 .node 认插件（require 一个 .dll 会走 JS 解析器）。改名是加载器的要求，
 * 不是编译产物的名字 —— 所以这一步由这里做，构建脚本里不重复一遍。
 *
 * POIETICA_NATIVE 覆盖候选路径，与 electron/native.ts 同一个变量。
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '..', '..', '..')

const failures = []

function check(condition, message) {
  if (!condition) {
    failures.push(message)
  }
}

/** 源码树里的插件位置；仓库根的 target/ 是共享构建目录。 */
function resolveNative() {
  const override = process.env.POIETICA_NATIVE

  if (override !== undefined && override.length > 0) {
    return override
  }

  const built = join(here, '..', 'native', 'target', 'debug', 'poietica.node')
  const shared = join(repository, 'target', 'debug', 'poietica.node')

  if (existsSync(built)) {
    return built
  }

  if (existsSync(shared)) {
    return shared
  }

  const source = [
    join(here, '..', 'native', 'target', 'debug', 'poietica.dll'),
    join(repository, 'target', 'debug', 'poietica.dll'),
  ].find((candidate) => existsSync(candidate))

  if (source === undefined) {
    throw new Error('没有找到原生库：先跑 cargo build -p poietica --lib，或设 POIETICA_NATIVE')
  }

  // 首次跑时 native/target/ 还不存在，cargo 也从来没往那儿写过东西。
  mkdirSync(dirname(built), { recursive: true })
  copyFileSync(source, built)

  return built
}

const dataRoot = mkdtempSync(join(tmpdir(), 'poietica-smoke-'))
const bundled = mkdtempSync(join(tmpdir(), 'poietica-smoke-bundled-'))
const frames = []

async function run() {
  const native = createRequire(import.meta.url)(resolveNative())

  check(typeof native.NativeHost === 'function', '原生库没有导出 NativeHost')
  check(native.contractFunctionCount() > 0, '命令面是空的')

  const host = new native.NativeHost()

  host.attach({ emit: (frame) => frames.push(frame) })
  await host.start({
    dataRoot,
    homeDirectory: process.env.USERPROFILE ?? tmpdir(),
    bundledDirectory: bundled,
  })

  // busy 是 getter 不是方法：写错成 host.busy() 会当场炸 TypeError。
  check(host.busy === false, 'start 之后不该还有命令在跑')

  const call = async (command, args = {}) =>
    JSON.parse(await host.invoke(command, JSON.stringify(args)))

  const directory = await call('storage_data_directory')
  check('ok' in directory, `storage_data_directory 该成功：${JSON.stringify(directory)}`)
  check(
    typeof directory.ok === 'string' && directory.ok.startsWith(dataRoot),
    `storage_data_directory 该回报传进去的 dataRoot：${JSON.stringify(directory.ok)}`,
  )
  check(directory.ok === dataRoot, '数据根就是 start 传进来的那个字符串')

  const unknown = await call('no_such_command')
  check('error' in unknown, '未知命令该回 { error } 而不是成功')
  check(
    unknown.error?.code === 'resourceMissing',
    `未知命令的码是 resourceMissing：${JSON.stringify(unknown.error)}`,
  )
  check(typeof unknown.error?.userMessageKey === 'string', 'Problem 要带 userMessageKey')

  // 忙闸：第一条还没跑完时再进一条，必须当场拒绝而不是排队 —— 拒绝是抛，不是回一个 error 信封。
  const gates = await Promise.allSettled([
    host.invoke('settings_get', '{}'),
    host.invoke('settings_get', '{}'),
  ])
  const rejected = gates.filter(
    (gate) => gate.status === 'rejected' && String(gate.reason).includes('still finishing'),
  )

  check(rejected.length === 1, `忙闸要挡住并发的那一条，实际挡了 ${rejected.length} 条`)
  check(
    gates.some((gate) => gate.status === 'fulfilled'),
    '两条里至少有一条该正常跑完',
  )

  // 事件帧的形状：原生侧推上来的是 { kind, payload } 的 JSON 文本，主进程按 kind 直接转发。
  for (const frame of frames) {
    const parsed = JSON.parse(frame)

    check(typeof parsed.kind === 'string', `事件帧没有 kind：${frame.slice(0, 120)}`)
    check('payload' in parsed, `事件帧没有 payload：${frame.slice(0, 120)}`)
  }

  await host.shutdown()

  return { frames, directory: directory.ok }
}

try {
  const result = await run()

  if (failures.length > 0) {
    console.error('smoke 失败：')
    for (const failure of failures) {
      console.error(`  - ${failure}`)
    }
    process.exitCode = 1
  } else {
    // biome-ignore lint/suspicious/noConsole: 自检的产物就是这一行 stdout
    console.log(`smoke ok（数据根 ${result.directory}，事件帧 ${result.frames.length} 条）`)
  }
} catch (cause) {
  console.error('smoke 失败：', cause)
  process.exitCode = 1
} finally {
  // 清不掉不算失败：进程里还按着 SQLite 的文件句柄，临时目录留给系统收。
  for (const directory of [dataRoot, bundled]) {
    try {
      rmSync(directory, { recursive: true, force: true })
    } catch {
      // 清不掉就留着
    }
  }
}
