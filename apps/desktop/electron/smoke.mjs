/*
 * 不启 GUI 的自检：只把原生库当普通 Node 插件加载，走一遍真实的 invoke 往返。
 * 它的产物就是 stdout 上那一行 smoke ok，console 在这里是输出而不是日志。
 *
 * 插件由 tools/dev/build-native.ts 备好（cargo 的 cdylib 改名成 .node，与该脚本同一处）。
 * 这里只读，不再自己复制一遍 —— 两份复制逻辑必然分叉成两个不同的版本。
 *
 * POIETICA_NATIVE 覆盖路径，与 electron/native.ts 同一个变量。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

/** 原生插件的开发期落点：tools/dev/build-native.ts 生成，与 .dll 同级。 */
function resolveNative() {
  const override = process.env.POIETICA_NATIVE

  if (override !== undefined && override.length > 0) {
    return override
  }

  const addon = join(repository, 'target', 'debug', 'poietica.node')

  if (!existsSync(addon)) {
    throw new Error(`没有找到原生库：先跑 bun run native:build（找的是 ${addon}）`)
  }

  return addon
}

const dataRoot = mkdtempSync(join(tmpdir(), 'poietica-smoke-'))
const bundled = mkdtempSync(join(tmpdir(), 'poietica-smoke-bundled-'))
const frames = []

/*
 * 设置文档先写下去：日志闸门（logging.level）在 start 里被读出来决定收哪些事件。
 * 写成 debug 才能证明「启动时读得到用户选的那一档」—— 默认那档与不读是同一个结果。
 */
writeFileSync(
  join(dataRoot, 'settings.json'),
  JSON.stringify({ settings: { logging: { level: 'debug' } } }),
)

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
    logDirectory: join(dataRoot, 'logs'),
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

  /* 日志闸门是设置文档里的一格，经 settings_get 读回来形状不变。 */
  const settings = await call('settings_get')
  check(
    settings.ok?.logging?.level === 'debug',
    `settings_get 该报出设定档：${JSON.stringify(settings.ok?.logging)}`,
  )

  const unknown = await call('no_such_command')
  check('error' in unknown, '未知命令该回 { error } 而不是成功')
  check(
    unknown.error?.code === 'resourceMissing',
    `未知命令的码是 resourceMissing：${JSON.stringify(unknown.error)}`,
  )
  check(typeof unknown.error?.userMessageKey === 'string', 'Problem 要带 userMessageKey')

  /*
   * 并发是允许的：这里从前断言「忙就当场拒绝」，而那道闸在 c9f1083c 被有意拆掉了 ——
   * 它把渲染层启动时并发发出的十几条读全部打成失败，界面上表现为「连不上 agent」。
   * 命令面的并发由各层自己的锁裁决（账本 actor、会话运行时），宿主不替它们串行化。
   * 所以这里验的正好相反：两条并发都跑完，且 busy 计数归零。
   */
  const gates = await Promise.allSettled([
    host.invoke('settings_get', '{}'),
    host.invoke('settings_get', '{}'),
  ])

  check(
    gates.every((gate) => gate.status === 'fulfilled'),
    `并发的两条都该正常跑完：${JSON.stringify(gates.map((gate) => gate.status))}`,
  )
  check(host.busy === false, '命令跑完之后 busy 计数该归零')

  // 事件帧的形状：原生侧推上来的是 { kind, payload } 的 JSON 文本，主进程按 kind 直接转发。
  for (const frame of frames) {
    const parsed = JSON.parse(frame)

    check(typeof parsed.kind === 'string', `事件帧没有 kind：${frame.slice(0, 120)}`)
    check('payload' in parsed, `事件帧没有 payload：${frame.slice(0, 120)}`)
  }

  /*
   * 日志目录是宿主交进去的事实（HostPaths.logDirectory），不是原生侧拼的名字。
   * 原生侧在 start 里对它 create_dir_all，所以它存在就证明这条链是通的。
   */
  check(existsSync(join(dataRoot, 'logs')), '宿主交的日志目录该被原生侧用上并建出来')

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
