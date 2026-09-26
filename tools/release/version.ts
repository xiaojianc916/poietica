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

export const TAURI_CONF = 'apps/desktop/src-tauri/tauri.conf.json'

/**
 * 版本号必须同步的四个声明处；Cargo workspace 是唯一真相，其余三处由它派生。
 * 发布脚本用它做失败签回与精确 add，set-version/check-versions 以它为键。
 */
export const VERSION_FILES = [
  'Cargo.toml',
  'package.json',
  'apps/desktop/package.json',
  TAURI_CONF,
] as const

export function workspaceVersion(text: string): string | undefined {
  return text.split(/^\[workspace\.package\]$/m)[1]?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
}
