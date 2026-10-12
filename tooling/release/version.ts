import { readFileSync } from 'node:fs'

/*
 * 仓库地址的唯一声明处是 apps/desktop/electron-builder.yml 的 publish 段 ——
 * 客户端真正会去拉的地址由它拼出来。发布脚本读同一份，两边不会各写各的。
 */
const BUILDER_CONFIG = 'apps/desktop/electron-builder.yml'

function repositoryBase(): string {
  const source = readFileSync(new URL(`../../${BUILDER_CONFIG}`, import.meta.url), 'utf8')
  const owner = /^\s*owner:\s*(\S+)\s*$/m.exec(source)?.[1]
  const repo = /^\s*repo:\s*(\S+)\s*$/m.exec(source)?.[1]
  if (!owner || !repo) {
    throw new Error(`${BUILDER_CONFIG}：publish 段缺 owner 或 repo，更新地址无从确定`)
  }
  return `https://github.com/${owner}/${repo}`
}

export const REPO_BASE = repositoryBase()

export const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export type Bump = { readonly patch: string; readonly minor: string; readonly major: string }

function coreOf(version: string): readonly [bigint, bigint, bigint] {
  const match = SEMVER.exec(version)
  if (!match) throw new Error(`invalid semantic version: ${version}`)
  const [, major = '0', minor = '0', patch = '0'] = match
  return [BigInt(major), BigInt(minor), BigInt(patch)]
}

export function bumped(version: string): Bump {
  const [major, minor, patch] = coreOf(version)
  return {
    patch: `${major}.${minor}.${patch + 1n}`,
    minor: `${major}.${minor + 1n}.0`,
    major: `${major + 1n}.0.0`,
  }
}

/**
 * 语义化版本的先后（SemVer §11）：交给 Bun 的官方实现（`Bun.semver.order`，
 * 数字标识符按数值比、非数字按字典序、构建元数据不参与）。
 *
 * 只在比较这一刻放宽：发布链认不认这个版本号，仍由上面的 SEMVER 正则判
 * （`v1.2.3`、`01.2.3` 这类会被 Bun 当合法收下，产品不接受）。
 */
export function compareVersions(left: string, right: string): number {
  return Bun.semver.order(left, right)
}

/**
 * 版本号的唯一来源是 `apps/desktop/package.json` 的 version（15 页 §10.1）。
 * Host 与 Core 总是一起发布，一个安装包里两半版本不一致只会意味着装坏了 ——
 * 所以 `apps/core/package.json` 必须与它相同，set-version/check-versions 以它为键。
 *
 * Core 的版本另有一处派生落点：`bun run core:build` 把 coreVersion 写进
 * `apps/core/dist/core-manifest.json`，由 verify-dist 与发布链核对，同样不在这个列表里。
 */
export const VERSION_SOURCE = 'apps/desktop/package.json'

export const VERSION_FILES = ['apps/desktop/package.json', 'apps/core/package.json'] as const

/**
 * 锁文件记着一份仓内包的版本（bun.lock 记 apps/desktop 与 apps/core）。它由包管理器
 * 重算，不手改 —— 手写解析等于给锁文件造第二个事实。
 *
 * 漏掉它的代价在 legacy 上实测过：v0.4.3 的发布提交里留下一个旧版本的 Cargo.lock，
 * 而签回与精确 add 都只认 VERSION_FILES —— 发布之后仓库一直带着一个改不完的改动。
 */
export const LOCK_FILES = ['bun.lock'] as const

/** 重算某个锁文件的命令：交给它自己的包管理器写，我们只负责调用。 */
export const LOCK_COMMANDS: Record<(typeof LOCK_FILES)[number], readonly [string, ...string[]]> = {
  /* 只重写锁文件，不碰 node_modules，也不跑 prepare。 */
  'bun.lock': ['bun', 'install', '--lockfile-only'],
}

/** 读一份 package.json 的顶层 version（JSON 解析，不靠正则猜）。 */
export function packageVersion(text: string): string | undefined {
  try {
    const parsed = JSON.parse(text) as { version?: unknown }
    return typeof parsed.version === 'string' ? parsed.version : undefined
  } catch {
    return undefined
  }
}
