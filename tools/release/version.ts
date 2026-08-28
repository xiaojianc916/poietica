/** 发布脚本共享的版本号工具：正则与自增只有这一处。 */

export const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

export type Bump = { readonly patch: string; readonly minor: string; readonly major: string }

/** 带预发布号的版本先剥尾巴再自增，否则算出 0.2.NaN。 */
export function bumped(version: string): Bump {
  const [major = 0, minor = 0, patch = 0] = (version.split('-')[0] ?? '').split('.').map(Number)

  return {
    patch: [major, minor, patch + 1].join('.'),
    minor: [major, minor + 1, 0].join('.'),
    major: [major + 1, 0, 0].join('.'),
  }
}

/** [workspace.package] 段里的 version —— 全仓库版本号的唯一真相。 */
export function workspaceVersion(text: string): string | undefined {
  return text.split(/^\[workspace\.package\]$/m)[1]?.match(/^version\s*=\s*"([^"]+)"/m)?.[1]
}
