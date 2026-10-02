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

type ParsedVersion = {
  readonly core: readonly [bigint, bigint, bigint]
  readonly prerelease: readonly string[] | null
}

function parseVersion(version: string): ParsedVersion {
  const match = SEMVER.exec(version)
  if (!match) {
    throw new Error(`invalid semantic version: ${version}`)
  }
  const [, major = '0', minor = '0', patch = '0', prerelease] = match
  return {
    core: [BigInt(major), BigInt(minor), BigInt(patch)],
    prerelease: prerelease?.split('.') ?? null,
  }
}

export function bumped(version: string): Bump {
  const [major, minor, patch] = parseVersion(version).core
  return {
    patch: `${major}.${minor}.${patch + 1n}`,
    minor: `${major}.${minor + 1n}.0`,
    major: `${major + 1n}.0.0`,
  }
}

function compareIdentifier(left: string, right: string): number {
  if (left === right) {
    return 0
  }
  const leftNumeric = /^\d+$/.test(left)
  const rightNumeric = /^\d+$/.test(right)
  if (leftNumeric && rightNumeric) {
    return BigInt(left) < BigInt(right) ? -1 : 1
  }
  if (leftNumeric) {
    return -1
  }
  if (rightNumeric) {
    return 1
  }
  return left < right ? -1 : 1
}

export function compareVersions(left: string, right: string): number {
  const leftVersion = parseVersion(left)
  const rightVersion = parseVersion(right)
  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const leftPart = leftVersion.core[index] ?? 0n
    const rightPart = rightVersion.core[index] ?? 0n
    if (leftPart !== rightPart) {
      return leftPart < rightPart ? -1 : 1
    }
  }
  if (leftVersion.prerelease === null) {
    return rightVersion.prerelease === null ? 0 : 1
  }
  if (rightVersion.prerelease === null) {
    return -1
  }
  const length = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftVersion.prerelease[index]
    const rightPart = rightVersion.prerelease[index]
    if (leftPart === undefined) {
      return -1
    }
    if (rightPart === undefined) {
      return 1
    }
    const compared = compareIdentifier(leftPart, rightPart)
    if (compared !== 0) {
      return compared
    }
  }
  return 0
}

/**
 * 版本号必须同步的三个声明处；Cargo workspace 是唯一真相，其余两处由它派生。
 * 发布脚本用它做失败签回与精确 add，set-version/check-versions 以它为键。
 *
 * 第三处（electron-builder 的产物名与 latest.yml）不再是手写文件：它由
 * apps/desktop/package.json 的 version 派生，所以这里没有第四个键。
 */
export const VERSION_FILES = ['Cargo.toml', 'package.json', 'apps/desktop/package.json'] as const

/**
 * 另有两个派生落点：两个锁文件各记一份仓内包的版本（Cargo.lock 记 17 个 crate，
 * bun.lock 记 apps/desktop）。它们由各自的包管理器重算，不手改 —— 手写解析等于
 * 给锁文件造第二个事实。
 *
 * 漏掉它们的代价是实测出来的：v0.4.3 的发布提交里留下一个旧版本的 Cargo.lock，
 * 而签回与精确 add 都只认 VERSION_FILES —— 发布之后仓库一直带着一个改不完的改动。
 */
export const LOCK_FILES = ['Cargo.lock', 'bun.lock'] as const

/** 重算某个锁文件的命令：交给它自己的包管理器写，我们只负责调用。 */
export const LOCK_COMMANDS: Record<(typeof LOCK_FILES)[number], readonly [string, ...string[]]> = {
  /* 只动 workspace 成员（仓内包）的版本，不升级任何第三方依赖。 */
  'Cargo.lock': ['cargo', 'update', '--workspace'],
  /* 只重写锁文件，不碰 node_modules，也不跑 prepare。 */
  'bun.lock': ['bun', 'install', '--lockfile-only'],
}

export function workspaceVersion(text: string): string | undefined {
  return text.split(/^\[workspace\.package\]$/m)[1]?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
}
