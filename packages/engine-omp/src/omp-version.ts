// omp 引擎版本。engine.info.version 会进入 core.ready 载荷与 diagnostics.core，契约要求它是
// string —— 缺了它 strict 模式下 diagnostics.core 整个方法失败。版本有两个来源、都不写死字面量
// （版本号只有 catalog 一个产地）：生产 exe 由 build.ts 编译期注入（exe 里没有 node_modules，
// 注入是必需的）；源码运行从随包安装的那份 package.json 现读（该包没有 exports ./package.json，
// require 不到，只能先解析入口再回包根）。
import { readFileSync } from 'node:fs'
import path from 'node:path'

declare const process: { env: Record<string, string | undefined> }

/** 探不到随包版本时的哨兵（只可能出现在既没注入、又没有 node_modules 的组合里） */
export const OMP_VERSION_UNKNOWN = '0.0.0-unknown'

/** 解析随包安装的那份 omp 的 package.json：先解析入口文件，再从包根读版本 */
function resolveOmpVersion(): string {
  try {
    // Bun.resolveSync 返回 <包>/src/index.ts；包根是它的上一级目录的上一级
    const entry = Bun.resolveSync('@oh-my-pi/pi-coding-agent', import.meta.dir)
    const pkgRoot = path.dirname(path.dirname(entry))
    const parsed = JSON.parse(readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : OMP_VERSION_UNKNOWN
  } catch {
    // 读不到就是读不到：调用方（core.ready / diagnostics.core）要的是 string，不是异常
    return OMP_VERSION_UNKNOWN
  }
}

export const OMP_VERSION: string = process.env.POIETICA_OMP_VERSION ?? resolveOmpVersion()
