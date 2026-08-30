import { assertUnreachable } from '@poietica/problem'

/*
 * 信任级别取自上游目录里那一列 tier。它是市场目录声明的事实，不从 URL 猜 ——
 * 猜出来的信任是最坏的一种信任。
 */
const PLUGIN_TRUST_TIERS = ['kimi-official', 'curated', 'third-party'] as const

export type PluginTrustTier = (typeof PLUGIN_TRUST_TIERS)[number]

/* 目录之外装进来的一律 third-party：手动指路径那条通道没有任何东西为它背书。 */
export const UNLISTED_TRUST: PluginTrustTier = 'third-party'

/*
 * 非官方来源一律要人点头，且默认落在取消上。装一个插件是把别人的代码请进自己
 * 的会话，默认值应该是「不」。
 */
export function requiresInstallConfirmation(trust: PluginTrustTier): boolean {
  return trust !== 'kimi-official'
}

export interface DefaultBranchRef {
  readonly kind: 'default-branch'
}

export interface TreeRef {
  readonly kind: 'tree'
  readonly ref: string
}

export interface ReleaseTagRef {
  readonly kind: 'release-tag'
  readonly tag: string
}

export interface CommitRef {
  readonly kind: 'commit'
  readonly sha: string
}

export type GitHubRef = CommitRef | DefaultBranchRef | ReleaseTagRef | TreeRef

export interface DirectorySource {
  readonly kind: 'directory'
  readonly path: string
}

export interface ArchiveSource {
  readonly kind: 'archive'
  readonly url: string
}

export interface GitHubSource {
  readonly kind: 'github'
  readonly owner: string
  readonly repo: string
  readonly ref: GitHubRef
  /**
   * 仓库里插件根所在的那一段路径。
   *
   * 一个仓库装多个插件是目录型市场的常态 —— kimi-code 的 plugins/official/ 下
   * 就并排放着两个。没有这一段，「装 kimi-datasource」只能解成「装整个 kimi-code
   * 仓库」，而那个仓库根本没有清单。
   *
   * 它只从显式来源来（目录里的相对路径、界面上的稀疏路径输入），不从网页地址里
   * 猜：/tree/<ref>/<path> 里 ref 与路径的分界线离线判不出来，分支名本身可以带
   * 斜杠，GitHub 自己是拿仓库的引用表在服务端试的。
   */
  readonly subdirectory: string | undefined
}

export type PluginInstallSource = ArchiveSource | DirectorySource | GitHubSource

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])

/*
 * 用 URL 解析 URL，不用正则切字符串：主机名规范化、端口、百分号编码、IDN ——
 * 这些边界情况平台已经解决过一遍，手搓必然漏。
 */
function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value)
  } catch {
    return undefined
  }
}

/*
 * 判据是协议白名单，不是「能不能构造出 URL」：Windows 盘符路径会被 URL 当成
 * 协议解析成功 —— new URL('C:\\plugins\\demo') 不抛，protocol 是 'c:'。这个仓库
 * 的发布目标就是 x86_64-pc-windows-msvc，所以这条不是假想。
 */
function asHttpUrl(value: string): URL | undefined {
  const url = parseUrl(value)

  return url !== undefined && HTTP_PROTOCOLS.has(url.protocol) ? url : undefined
}

function parseGitHubRef(rest: readonly string[]): GitHubRef {
  const [kind, ...tail] = rest
  const joined = tail.join('/')

  if (kind === 'tree' && joined !== '') {
    return { kind: 'tree', ref: joined }
  }

  if (kind === 'commit' && joined !== '') {
    return { kind: 'commit', sha: joined }
  }

  if (kind === 'releases' && tail[0] === 'tag' && tail.length > 1) {
    return { kind: 'release-tag', tag: tail.slice(1).join('/') }
  }

  return { kind: 'default-branch' }
}

/*
 * 一条来源说明串到底是什么，只在这里判一次。上游支持四种：本地目录、直链压缩
 * 包、GitHub 仓库地址，以及 GitHub 地址上的三种定位（tree / releases-tag / commit）。
 */
export function parseInstallSource(specifier: string): PluginInstallSource {
  const url = asHttpUrl(specifier)

  if (url === undefined) {
    return { kind: 'directory', path: specifier }
  }

  if (!GITHUB_HOSTS.has(url.hostname)) {
    return { kind: 'archive', url: url.toString() }
  }

  const segments = url.pathname.split('/').filter((segment) => segment !== '')
  const owner = segments[0]
  const repo = segments[1]

  if (owner === undefined || repo === undefined) {
    return { kind: 'archive', url: url.toString() }
  }

  return {
    kind: 'github',
    owner,
    repo: repo.replace(/\.git$/, ''),
    ref: parseGitHubRef(segments.slice(2)),
    subdirectory: undefined,
  }
}

/*
 * 给人看的一行字，同时也是「两个来源是不是同一个」的判据。
 *
 * 它不承诺能被 parseInstallSource 读回去 —— 子目录在网页地址里没有无歧义的写法，
 * 硬造一个可逆字符串就等于把上面那条「不猜」的纪律绕过去。要还原来源的地方（账本、
 * 卡片）一律传结构，不传字符串。
 */
export function describeInstallSource(source: PluginInstallSource): string {
  switch (source.kind) {
    case 'archive':
      return source.url
    case 'directory':
      return source.path
    case 'github': {
      const repository = `github.com/${source.owner}/${source.repo}`

      return source.subdirectory === undefined ? repository : `${repository}/${source.subdirectory}`
    }
    default:
      return assertUnreachable(source)
  }
}
