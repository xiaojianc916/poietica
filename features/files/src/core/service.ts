import type { Dirent } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { AppError } from '@poietica/foundation'
import type { DirectoryListing, FileContent, FileEntry, FileEntryKind, FileSearchHit, LocatedFile } from '../contract'
import { filesErrors } from '../contract/errors'
import { imageMimeOf } from '../contract/media'
import { decodeText } from './decode'
import { fsFailure, resolveReal } from './paths'

/* 一个目录最多列这么多条：再多树也没法看，筛选（files.search）才是正路。 */
export const LIST_LIMIT = 2000
/* 正文最多读 1 MiB：查看器只读、不编辑，一份几十 MB 的日志读进渲染进程只会把窗口卡死。 */
export const TEXT_LIMIT = 1024 * 1024
/* 不是仓库时遍历的上限：防一个指向 C:\ 的工作区把 Core 拖进几十万个文件里。 */
const WALK_LIMIT = 20_000
const SEARCH_LIMIT = 200
/* 文件清单（搜索用）缓存多久：监听到变化会提前作废，这个数只兜「没在监听」的那几处。 */
const LISTING_TTL_MS = 10_000

export interface FilesGit {
  /** git check-ignore：交回被忽略的那些（原样交回传进去的字符串）；不是仓库时空集。 */
  ignored(root: string, candidates: readonly string[]): Promise<ReadonlySet<string>>
  /** git ls-files（已跟踪 + 未跟踪未忽略）；不是仓库时 null。 */
  files(root: string): Promise<readonly string[] | null>
}

export interface FilesService {
  list(root: string, input: string): Promise<DirectoryListing>
  read(root: string, input: string): Promise<FileContent>
  locate(root: string, input: string): Promise<LocatedFile>
  search(root: string, query: string, limit?: number): Promise<{ hits: FileSearchHit[]; truncated: boolean }>
  /** 这个根下的文件变了：搜索用的清单作废。 */
  invalidate(root: string): void
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

function joinRelative(dir: string, name: string): string {
  return dir === '' ? name : `${dir}/${name}`
}

async function kindOf(entry: Dirent, absolute: string): Promise<FileEntryKind> {
  if (entry.isDirectory()) return 'directory'
  if (!entry.isSymbolicLink()) return 'file'
  /* 链接按它指向的东西算；断链当文件列出来，点开时由 read 报 not_found。 */
  try {
    return (await stat(absolute)).isDirectory() ? 'directory' : 'file'
  } catch {
    return 'file'
  }
}

function byKindThenName(left: FileEntry, right: FileEntry): number {
  if (left.kind !== right.kind) return left.kind === 'directory' ? -1 : 1
  return collator.compare(left.name, right.name)
}

async function readHead(file: string, length: number): Promise<Uint8Array> {
  const handle = await open(file, 'r')
  try {
    const buffer = new Uint8Array(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/* 不是仓库时的有界遍历：跳过 .git 与 node_modules，到上限就停。 */
async function walk(root: string): Promise<readonly string[]> {
  const found: string[] = []
  const pending: string[] = ['']
  while (pending.length > 0 && found.length < WALK_LIMIT) {
    const dir = pending.shift() ?? ''
    const entries = await readdir(path.join(root, dir), { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const relative = joinRelative(dir, entry.name)
      if (entry.isDirectory()) pending.push(relative)
      else found.push(relative)
    }
  }
  return found.slice(0, WALK_LIMIT)
}

/* 名字命中排前面，其次路径短的：人筛 review-pane 时要的是那个文件，不是某个目录里恰好带这几个字的一长串。 */
function rank(file: string, last: string): number {
  const base = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
  if (base.startsWith(last)) return 0
  if (base.includes(last)) return 1
  return 2
}

export function matchPaths(
  files: readonly string[],
  query: string,
  limit: number,
): { hits: string[]; truncated: boolean } {
  const terms = query
    .toLowerCase()
    .split(/\s+/u)
    .filter((term) => term !== '')
  const last = terms.at(-1)
  if (last === undefined) return { hits: [], truncated: false }
  const matched = files.filter((file) => {
    const lower = file.toLowerCase()
    return terms.every((term) => lower.includes(term))
  })
  matched.sort(
    (left, right) =>
      rank(left, last) - rank(right, last) || left.length - right.length || collator.compare(left, right),
  )
  return { hits: matched.slice(0, limit), truncated: matched.length > limit }
}

export function createFilesService(d: { readonly git: FilesGit; readonly now?: () => number }): FilesService {
  const now = d.now ?? Date.now
  /* 搜索清单按根缓存；作废走 invalidate，过期按 TTL —— 两条都删条目，Map 不会只增不减。 */
  const listings = new Map<string, { readonly at: number; readonly files: Promise<readonly string[]> }>()

  const listingOf = (root: string): Promise<readonly string[]> => {
    const held = listings.get(root)
    if (held !== undefined && now() - held.at < LISTING_TTL_MS) return held.files
    const files = d.git
      .files(root)
      .then((tracked) => tracked ?? walk(root))
      .catch((cause: unknown) => {
        listings.delete(root)
        throw cause
      })
    listings.set(root, { at: now(), files })
    return files
  }

  return {
    async list(root, input) {
      const at = await resolveReal(root, input)
      const dirents = await readdir(at.real, { withFileTypes: true }).catch((cause: unknown) => {
        throw fsFailure(cause, input)
      })
      const visible = dirents.filter((entry) => entry.name !== '.git')
      const entries = await Promise.all(
        visible.map(async (entry): Promise<FileEntry> => ({
          name: entry.name,
          path: joinRelative(at.relative, entry.name),
          kind: await kindOf(entry, path.join(at.real, entry.name)),
          ignored: false,
        })),
      )
      entries.sort(byKindThenName)
      const kept = entries.slice(0, LIST_LIMIT)
      /* check-ignore 认目录要带尾斜杠（`dist/` 这类规则只匹配目录）。 */
      const asked = kept.map((entry) => (entry.kind === 'directory' ? `${entry.path}/` : entry.path))
      const ignored = await d.git.ignored(root, asked)
      return {
        path: at.relative,
        entries: kept.map((entry, index) => ({ ...entry, ignored: ignored.has(asked[index] ?? '') })),
        truncated: entries.length > LIST_LIMIT,
      }
    },

    async read(root, input) {
      const at = await resolveReal(root, input)
      const info = await stat(at.real).catch((cause: unknown) => {
        throw fsFailure(cause, input)
      })
      if (info.isDirectory()) throw new AppError(filesErrors.is_directory, `是目录：${input}`, { path: input })
      const stamp = { path: at.relative, size: info.size, mtimeMs: info.mtimeMs }
      const mime = imageMimeOf(at.relative)
      if (mime !== null) return { kind: 'image', ...stamp, mime }
      const truncated = info.size > TEXT_LIMIT
      const head = await readHead(at.real, Math.min(info.size, TEXT_LIMIT)).catch((cause: unknown) => {
        throw fsFailure(cause, input)
      })
      const decoded = decodeText(head, truncated)
      if (decoded === null) return { kind: 'binary', ...stamp }
      return { kind: 'text', ...stamp, ...decoded, truncated }
    },

    async locate(root, input) {
      const at = await resolveReal(root, input)
      const info = await stat(at.real).catch((cause: unknown) => {
        throw fsFailure(cause, input)
      })
      return { path: at.relative, absolutePath: at.absolute, kind: info.isDirectory() ? 'directory' : 'file' }
    },

    async search(root, query, limit = SEARCH_LIMIT) {
      const files = await listingOf(root)
      const found = matchPaths(files, query, limit)
      return { hits: found.hits.map((file) => ({ path: file })), truncated: found.truncated }
    },

    invalidate(root) {
      listings.delete(root)
    },
  }
}
