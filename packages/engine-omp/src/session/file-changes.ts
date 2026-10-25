import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

/*
 * 工具写文件的前后正文。撤销一轮的改动只能靠它：写完之后工作区里只剩新内容，
 * 谁事后去读都拿不回写之前那一份。所以读是在**工具开跑之前**做的那一下。
 *
 * 只认会写文件的工具，且只认文本：二进制（含 NUL）、超大文件、读不到的一律不记 ——
 * 记一份读不准的 before 比不记更糟，撤销时会把文件写成别的东西。
 *
 * omp 知识 #23：`edit` 的产出 details 里，`oldText` 是改之前的原文（新建时为 undefined），
 * `newText` 是改之后的（删除时为 undefined）；一次编辑改多个文件时在 `perFileResults` 里逐条给，
 * 单文件时平铺在 details 上。超大快照会被 `pruneOversizedEditSnapshots` 抹掉（同一格多一条
 * `snapshotsPruned` 标记）—— 那几档都得退回到开工前抄下的那一份，不能拿 undefined 当空串。
 */

/** 会写文件的工具名（omp 的内置名字）。别的工具即便改文件（bash、eval），前后正文也不在它们手里。 */
const WRITE_TOOLS: ReadonlySet<string> = new Set(['apply_patch', 'ast_edit', 'edit', 'notebook', 'write'])

/** 超过这么多字节的文件不记：撤销要把整份 before 写回内存和库里，日志与产物级的大文件不在此列。 */
const MAX_BYTES = 4 * 1024 * 1024

/** 从入参里能认出来的路径键。omp 的 write 用 path，别的工具多了 file_path / paths 两种写法。 */
const PATH_KEYS = ['path', 'file_path'] as const
const PATH_LIST_KEYS = ['paths'] as const

function stringsOf(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one !== '') : []
}

function bagOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

/** 这次调用的入参点名的那些文件；认不出来就是空表。 */
export function writePathsOf(toolName: string, input: unknown): readonly string[] {
  if (!WRITE_TOOLS.has(toolName)) {
    return []
  }

  const args = bagOf(input)

  if (args === undefined) {
    return []
  }

  const found: string[] = []

  for (const key of PATH_KEYS) {
    const value = args[key]

    if (typeof value === 'string' && value !== '') {
      found.push(value)
    }
  }

  for (const key of PATH_LIST_KEYS) {
    found.push(...stringsOf(args[key]))
  }

  return found
}

/**
 * 文本正文；不存在交 undefined、读不成的（二进制、太大、出错）交 null。
 *
 * 两者要分开：`undefined` 是「这个文件本来就不在」（撤销时该删掉它），`null` 是「我读不准这一份」
 * （不记账）。合成一个值就会把「新建的文件」与「读不出的二进制」放成同一档。
 */
export async function readText(absolute: string): Promise<string | null | undefined> {
  try {
    const info = await stat(absolute)

    if (!info.isFile() || info.size > MAX_BYTES) {
      return null
    }

    const text = await readFile(absolute, 'utf8')

    /* NUL 是二进制最可靠的那个记号：UTF-8 文本里不会出现它。 */
    return text.includes('\u0000') ? null : text
  } catch (error) {
    return isMissing(error) ? undefined : null
  }
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && String(error.code) === 'ENOENT'
}

/**
 * 开工前把要写的那些文件的正文抄下来 —— 文件不存在记 `undefined`，读不成的不进表（那一份不记账）。
 * 键是绝对路径：收尾时按它对回去。
 */
export async function captureBefore(
  cwd: string,
  paths: readonly string[],
): Promise<Map<string, string | null | undefined>> {
  const held = new Map<string, string | null | undefined>()

  for (const raw of paths) {
    const absolute = path.resolve(cwd, raw)

    if (held.has(absolute)) {
      continue
    }

    const text = await readText(absolute)

    if (text !== null) {
      held.set(absolute, text)
    }
  }

  return held
}

/** 一处改动的两面都能缺席：新建没有 before、删除没有 after、被 prune 时两个都没有。 */
interface ResultEntry {
  readonly path: string
  readonly before: string | null | undefined
  readonly after: string | null | undefined
}

function textOrUndefined(value: unknown): string | null | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 一条 details 条目 → 一处改动；没有 path 的条目不是改动（omp 用它放聚合信息）。 */
function entryOf(raw: unknown): ResultEntry | null {
  const entry = bagOf(raw)
  const at = entry?.path

  if (typeof at !== 'string' || at === '') {
    return null
  }

  return { path: at, before: textOrUndefined(entry?.oldText), after: textOrUndefined(entry?.newText) }
}

function entriesOf(details: unknown): readonly ResultEntry[] {
  const bag = bagOf(details)

  if (bag === undefined) {
    return []
  }

  const many = bag.perFileResults
  const source = Array.isArray(many) ? many : [bag]

  return source.map(entryOf).filter((entry): entry is ResultEntry => entry !== null)
}

/** 一处改动（引擎端口那份形状，轮号由调用方补）。 */
export interface FileWrite {
  readonly path: string
  readonly before: string | null
  readonly after: string | null
}

/**
 * 一条 details 条目算出来的改动；这一面读不准（二进制 / 太大 / 出错）时交 null（不记）。
 *
 * details 那一格缺席 = 这一面没有正文（新建 / 删除 / 被 prune）：退回开工前抄下的那一份，
 * after 再退到盘上现在的内容。
 */
async function changeOfEntry(
  cwd: string,
  entry: ResultEntry,
  captured: ReadonlyMap<string, string | null | undefined>,
): Promise<FileWrite | null> {
  const absolute = path.resolve(cwd, entry.path)
  const before = entry.before ?? captured.get(absolute) ?? null
  const read = entry.after === undefined ? await readText(absolute) : entry.after

  /* 读不准：这一处不记，宁可撤销时少一个文件也不写坏它 */
  if (read === null) {
    return null
  }

  /* 缺席即这一回把它删了（omp 的 delete 不写 newText），撤销就是写回 before */
  const after = read ?? null

  return before === after ? null : { path: absolute, before, after }
}

/** 开工前抄下、但 details 没提的那些文件：盘上现在的内容就是 after。 */
async function changeOfCaptured(absolute: string, before: string | null | undefined): Promise<FileWrite | null> {
  const read = await readText(absolute)

  /* 读不出新内容，或与开工前一模一样：这一份不记 */
  if (read === null || read === before) {
    return null
  }

  return { path: absolute, before: before ?? null, after: read ?? null }
}

/**
 * 收尾时算这一回到底写了哪些文件。
 *
 * 两条来源：产出 details 自报的（带前后正文，最准），以及开工前抄下的那些。前后一样的文件
 * 不算一次改动 —— 模型写了一遍与原样相同的内容时，屏幕上也不该多出一条「已更改」。
 */
export async function changesOf(
  cwd: string,
  toolName: string,
  result: { readonly details?: unknown; readonly isError: boolean },
  captured: ReadonlyMap<string, string | null | undefined>,
): Promise<readonly FileWrite[]> {
  if (result.isError || !WRITE_TOOLS.has(toolName)) {
    return []
  }

  const changes: FileWrite[] = []
  const seen = new Set<string>()

  for (const entry of entriesOf(result.details)) {
    const change = await changeOfEntry(cwd, entry, captured)

    seen.add(path.resolve(cwd, entry.path))

    if (change !== null) {
      changes.push(change)
    }
  }

  for (const [absolute, before] of captured) {
    if (seen.has(absolute)) {
      continue
    }

    const change = await changeOfCaptured(absolute, before)

    if (change !== null) {
      changes.push(change)
    }
  }

  return changes
}
