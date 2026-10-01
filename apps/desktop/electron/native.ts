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
  new (): NativeHost
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

  // 开发期：cargo 把 cdylib 产出在仓库的 target/ 下，smoke.mjs 会改名复制成 .node。
  return [join(app.getAppPath(), 'native', 'target', 'debug', 'poietica.node')]
}

export function loadNative(): NativeHost {
  const resolve = createRequire(join(app.getAppPath(), 'package.json'))
  const failures: string[] = []

  for (const candidate of nativeCandidates()) {
    try {
      const loaded: unknown = resolve(candidate)

      if (typeof loaded !== 'function') {
        failures.push(`${candidate}: 模块没有导出宿主构造函数`)
        continue
      }

      return new (loaded as NativeModule)()
    } catch (cause) {
      failures.push(`${candidate}: ${String(cause)}`)
    }
  }

  throw new Error(`原生库加载失败：\n${failures.join('\n')}`)
}
