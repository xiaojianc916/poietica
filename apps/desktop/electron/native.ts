import { createRequire } from 'node:module'
import { join } from 'node:path'

import { app } from 'electron'

/** 原生宿主的一个实例。方法面是 Rust 侧 NativeHost 的原样（正本 apps/desktop/native/src/ipc/transport.rs）。 */
export interface NativeHostPaths {
  readonly dataRoot: string
  readonly homeDirectory: string
  readonly bundledDirectory: string
}

export interface NativeHost {
  attach(ports: { emit: (frame: string) => void }): void
  start(paths: NativeHostPaths): Promise<void>
  invoke(command: string, argsJson: string): Promise<string>
  shutdown(): Promise<void>
}

interface NativeModule {
  readonly NativeHost: new () => NativeHost
}

/**
 * 候选路径按「谁是这次运行的真身」排序，全都不存在时把三条路径与原始错误一起报出去 ——
 * 只说一句「加载失败」的话，开发机上分不出是没编译还是路径猜错了。
 */
function nativeCandidates(): readonly string[] {
  const override = process.env['POIETICA_NATIVE']

  if (override !== undefined && override.length > 0) {
    return [override]
  }

  if (app.isPackaged) {
    // asar 里的 .node 会被抽到临时文件再 dlopen；electron-builder 的 asarUnpack 已经把它放在 unpacked 下，路径只能自己拼。
    return [join(process.resourcesPath, 'app.asar.unpacked', 'native', 'poietica.node')]
  }

  // 开发期：tools/dev/build-native.ts 把 cdylib 改名成 .node 放在 cargo 自己的 target 下。
  // 它与 .dll 同级，所以不会出现「.node 是上一次构建、.dll 是这一次」的陈旧副本。
  //
  // 两条候选而不是一条：`app.getAppPath()` 在开发期取决于谁把 Electron 拉起来的 ——
  // electron-vite 从 dist-electron 起（三层到仓库根），直接 `electron .` 从 apps/desktop
  // 起（两层）。写死一条就会在另一种跑法下找不到插件，而这里本来就是一个候选列表。
  const addon = ['debug', 'release'].map((profile) => join('target', profile, 'poietica.node'))

  return [
    ...addon.map((relative) => join(app.getAppPath(), '..', '..', '..', relative)),
    ...addon.map((relative) => join(app.getAppPath(), '..', '..', relative)),
  ]
}

export function loadNative(): NativeHost {
  const resolve = createRequire(join(app.getAppPath(), 'package.json'))
  const failures: string[] = []

  for (const candidate of nativeCandidates()) {
    try {
      const loaded = resolve(candidate) as Partial<NativeModule>

      /* napi 的导出面是 { NativeHost, echo, contractFunctionCount }，宿主是它的成员，不是模块本身。 */
      if (typeof loaded?.NativeHost !== 'function') {
        failures.push(`${candidate}: 模块没有导出 NativeHost`)
        continue
      }

      return new loaded.NativeHost()
    } catch (cause) {
      failures.push(`${candidate}: ${String(cause)}`)
    }
  }

  throw new Error(`原生库加载失败：\n${failures.join('\n')}`)
}
