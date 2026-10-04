import { createRequire } from 'node:module'
import { join } from 'node:path'

import { app } from 'electron'

import { nativeCandidates } from './native-paths'

/** 原生宿主的一个实例。方法面是 Rust 侧 NativeHost 的原样（正本 apps/desktop/native/src/ipc/transport.rs）。 */
export interface NativeHostPaths {
  readonly dataRoot: string
  readonly homeDirectory: string
  readonly bundledDirectory: string
  /** Electron 的 app.getPath('logs')；主进程与原生侧写的是同一个目录。 */
  readonly logDirectory: string
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

export function loadNative(): NativeHost {
  const resolve = createRequire(join(app.getAppPath(), 'package.json'))
  const failures: string[] = []

  for (const candidate of nativeCandidates({
    override: process.env['POIETICA_NATIVE'],
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  })) {
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
