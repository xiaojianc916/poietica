/**
 * omp SDK 参考文档的行号锚点：核对与刷新（AGENTS.md §11「升级 omp」的第一步）。
 *
 * 背景：`docs/omp-sdk-reference.md` 是 omp 公开面的手抄副本，每个 ```ts 块头上写着
 * `// from: <包根>/<文件>:<起>-<止>`。正文是逐字抄的，行号却会随 omp 升级整体漂移 ——
 * 一次小版本升级就能漂出上百行；relay 协议的缺陷正是因为「对着旧文档核对」而漏掉的
 * （refactor-log Q43）。漂移是**静默**的：文档照样能读，读到的却是旧的。
 *
 * 所以：文档里不许写死版本号（头一行与 PKGROOT 路径都由本工具按随包那份 omp 现填），
 * 行号锚点由本工具重算。默认只核对；`--write` 就地刷新行号（内容仍然要人按 §11 逐项核对）。
 *
 * 用法：bun run tooling/checks/omp-sdk-doc.ts         只核对（由 bun run lint 调用）
 *      bun run tooling/checks/omp-sdk-doc.ts --write  刷新头一行与各块的行号区间
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const DOC = path.join(ROOT, 'docs/omp-sdk-reference.md')
const write = process.argv.includes('--write')
/** 名字与行号允许的偏差：块里的 `名字:N` 指的是「这一带」，不是精确单行 */
const LINE_TOLERANCE = 3
/** 文档头第 3 行写着各包根路径（第 2 行是空行），路径里的版本化目录名由本工具现填 */
const HEADER_PATH_LINE = 3
const HEADER_PACKAGES: Readonly<Record<string, string>> = {
  PKGROOT: 'pi-coding-agent',
  AIROOT: 'pi-ai',
  UTILSROOT: 'pi-utils',
  TUIROOT: 'pi-tui',
  COREROOT: 'pi-agent-core',
}

/** 包根：bunfig 用 isolated linker，omp 装在自己的 node_modules 下，只有 .bun 目录能按名字找到 */
function ompRoots(): Record<string, string> {
  const bunRoot = path.join(ROOT, 'node_modules/.bun')
  const find = (name: string): string => {
    for (const dir of readdirSync(bunRoot)) {
      if (!dir.startsWith(`@oh-my-pi+${name}@`)) continue
      const candidate = path.join(bunRoot, dir, 'node_modules/@oh-my-pi', name)
      if (existsSync(path.join(candidate, 'package.json'))) return candidate
    }
    return ''
  }
  return {
    PKGROOT: find('pi-coding-agent'),
    AIROOT: find('pi-ai'),
    UTILSROOT: find('pi-utils'),
    TUIROOT: find('pi-tui'),
    COREROOT: find('pi-agent-core'),
  }
}

interface Block {
  /** 文档里的行号（1 起），指向 `// from:` 那一行 */
  readonly line: number
  readonly header: string
  /** 头上的后续注释行（折行的情况）与正文 */
  readonly body: readonly string[]
}

function parseBlocks(doc: readonly string[]): Block[] {
  const blocks: Block[] = []
  for (let i = 0; i < doc.length; i++) {
    const header = doc[i]
    if (header === undefined || !header.startsWith('// from:')) continue
    const body: string[] = []
    for (let j = i + 1; j < doc.length && !(doc[j] ?? '').startsWith('```'); j++) body.push(doc[j] ?? '')
    blocks.push({ line: i + 1, header, body })
  }
  return blocks
}

interface Anchor {
  readonly root: string
  readonly rel: string
  /** 头一行里第一个区间 token 在字符串中的位置，刷新时原地替换 */
  readonly tokenStart: number
  readonly tokenEnd: number
}

/** `// from: ROOT/rel:12-30 …` → 根、相对路径与第一个区间 token 的位置 */
function parseHeader(header: string): Anchor | null {
  const m = header.match(/^\/\/ from:\s+([A-Z]*ROOT\/)?([^\s:()]+)/)
  if (m === null || m[2] === undefined) return null
  const root = m[1] === undefined ? 'PKGROOT' : m[1].slice(0, -1)
  const after = header.slice(m[0].length)
  const range = after.match(/:\s*\d+(?:\s*-\s*\d+)?/)
  if (range === null || range.index === undefined) return { root, rel: m[2], tokenStart: -1, tokenEnd: -1 }
  const tokenStart = m[0].length + range.index
  return { root, rel: m[2], tokenStart, tokenEnd: tokenStart + range[0].length }
}

const squash = (line: string): string => line.replace(/\s+/g, ' ').trim()

/** 去掉整行注释：文档里抄的是声明本身，源文件里夹着 JSDoc/行注释 */
const isComment = (line: string): boolean => {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')
}

interface SourceView {
  readonly lines: readonly string[]
  /** 只留声明行、压成一行：文档把折行并成一行，逐行比会找不到 */
  readonly flat: string
  /** flat 里第 i 个字符属于源文件哪一行（1 起） */
  readonly lineAt: readonly number[]
  /** 同上，但把标点两侧的空白也去掉：文档把 `f(\n  a,\n  b)` 并成 `f(a, b)` 时括号后才不会多个空格 */
  readonly tight: string
  readonly tightLineAt: readonly number[]
}

/** 标点两侧的空白统一去掉；比 `flat` 再宽一档，用来接住「并成一行」造成的空白差异 */
const tighten = (text: string): string => text.replace(/\s*([(),;:{}[\]<>=])\s*/g, '$1')

function makeSourceView(text: string): SourceView {
  const lines = text.split('\n')
  const lineAt: number[] = []
  const tightLineAt: number[] = []
  let flat = ''
  let tight = ''
  for (const [index, line] of lines.entries()) {
    if (isComment(line)) continue
    const chunk = `${squash(line)} `
    flat += chunk
    for (let i = 0; i < chunk.length; i++) lineAt.push(index + 1)
    const tightChunk = tighten(chunk)
    tight += tightChunk
    for (let i = 0; i < tightChunk.length; i++) tightLineAt.push(index + 1)
  }
  return { lines, flat, lineAt, tight, tightLineAt }
}

/** 引用行在源文件里的行号：带省略号的比前缀；先按压平文本，再退一步按去空白标点的文本 */
function lineOf(view: SourceView, quoted: string): number | null {
  const target = squash(quoted)
  if (target.length === 0 || target.startsWith('//') || target.startsWith('…')) return null
  const cut = target.indexOf('…')
  const probe = (cut > 0 ? target.slice(0, cut).trim() : target).slice(0, 70)
  if (probe.length === 0) return null
  const at = view.flat.indexOf(probe)
  if (at !== -1) return view.lineAt[at] ?? null
  const tight = tighten(probe)
  const tightAt = view.tight.indexOf(tight)
  if (tightAt !== -1) return view.tightLineAt[tightAt] ?? null
  return null
}

/** 一行里括号的净变化：声明跨行时用它判断语句还没结束 */
function bracketDelta(line: string): number {
  let depth = 0
  for (const ch of line) {
    if ('([{'.includes(ch)) depth++
    else if (')]}'.includes(ch)) depth--
  }
  return depth
}

/**
 * 一条声明在源文件里覆盖到的最后一行：块头写的是「这一段」——
 * `dist/types/…d.ts:12-30` 这类区间指的是整条声明，不是其中一行。
 */
function statementEnd(lines: readonly string[], start: number): number {
  let depth = 0
  for (let i = start - 1; i < lines.length; i++) {
    depth += bracketDelta(lines[i] ?? '')
    const end = (lines[i] ?? '').trimEnd()
    if (isComment(lines[i] ?? '')) continue
    if (depth <= 0 && /[;}]$/.test(end)) return i + 1
  }
  return start
}

/** 块内引用的最小-最大行号：拿不到任何一行的块不刷新（例如「整个文件」那一类） */
function spanOf(view: SourceView, body: readonly string[]): [number, number] | null {
  const hits = body.map((l) => lineOf(view, l)).filter((n): n is number => n !== null)
  if (hits.length === 0) return null
  const start = Math.min(...hits)
  return [start, Math.max(...hits.map((n) => statementEnd(view.lines, n)))]
}

const rangeToken = (span: readonly [number, number]): string =>
  span[0] === span[1] ? `:${span[0]}` : `:${span[0]}-${span[1]}`

interface Finding {
  readonly at: string
  readonly detail: string
}

interface FileCache {
  readonly get: (root: string, rel: string) => SourceView | null
}

function makeCache(roots: Record<string, string>): FileCache {
  const files = new Map<string, SourceView | null>()
  return {
    get(root, rel) {
      const key = `${root}/${rel}`
      const hit = files.get(key)
      if (hit !== undefined) return hit
      const base = roots[root]
      const abs = base === undefined ? null : path.join(base, rel)
      const view = abs !== null && existsSync(abs) ? makeSourceView(readFileSync(abs, 'utf8')) : null
      files.set(key, view)
      return view
    },
  }
}

/** 一个 `名字:N` 锚点：`from` 是它所在的 `// from:` 头（没有就按 PKGROOT 猜） */
interface InlineRef {
  readonly line: number
  readonly name: string
  readonly number: number
  readonly root: string
  readonly rel: string
}

/** 文档正文里的全部 `名字:N` 锚点；块头自己那一行也是锚点（`discoverAuthStorage:415` 这种） */
function collectInlineRefs(doc: readonly string[]): InlineRef[] {
  const out: InlineRef[] = []
  let context: { root: string; rel: string } | null = null
  for (const [index, text] of doc.entries()) {
    if (text.startsWith('```')) continue
    const header = parseHeader(text)
    if (header !== null) context = { root: header.root, rel: header.rel }
    for (const m of text.matchAll(/`([A-Za-z_$][\w$]*):(\d+)`/g)) {
      const name = m[1]
      const raw = m[2]
      if (name === undefined || raw === undefined || context === null) continue
      out.push({ line: index + 1, name, number: Number(raw), root: context.root, rel: context.rel })
    }
  }
  return out
}

/** 声明形态的行：`名字` 出现在这些行上才算「它在这一行」 */
function declarationPatterns(name: string): RegExp[] {
  return [
    new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:async\\s+)?function\\s+${name}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?const\\s+${name}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+${name}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?interface\\s+${name}\\b`),
    new RegExp(`^\\s*(?:export\\s+)?(?:declare\\s+)?type\\s+${name}\\b`),
    new RegExp(`^\\s*(?:static\\s+|readonly\\s+|async\\s+|abstract\\s+)*(?:get\\s+|set\\s+)?${name}\\s*[(<:=?]`),
  ]
}

/**
 * 名字在本文件里的行号：优先声明行（文档的约定是「声明在第几行」），
 * 同一档里取离文档写的行号最近的一处 —— 注释里提到同名符号的行不算。
 */
function lineOfName(view: SourceView, name: string, claimed: number): number | null {
  const patterns = declarationPatterns(name)
  const declared: number[] = []
  const mentioned: number[] = []
  for (const [index, line] of view.lines.entries()) {
    if (!line.includes(name)) continue
    if (patterns.some((re) => re.test(line))) declared.push(index + 1)
    else mentioned.push(index + 1)
  }
  const pool = declared.length > 0 ? declared : mentioned
  if (pool.length === 0) return null
  return pool.reduce((best, n) => (Math.abs(n - claimed) < Math.abs(best - claimed) ? n : best), pool[0] ?? 0)
}

/** 行内出现的源文件路径：一行可能同时说两个文件（`Full export list of UTILSROOT/src/x.ts: …`） */
const FILE_TOKEN = /(?:[A-Z]*ROOT\/)?((?:src|dist|packages)\/[A-Za-z0-9_./+-]+\.(?:ts|tsx|json|js))/g

/**
 * 这一行的锚点归哪一份文件：行自己点了名就以它为准（相对包根），否则用块的 `// from:` 文件。
 * 归属错了会拿 A 文件的形状去改 B 文件的行号 —— 比不刷新更糟。
 */
function fileForLine(text: string, fallback: string): string {
  const named = [...text.matchAll(FILE_TOKEN)].map((m) => m[1]).filter((f): f is string => f !== undefined)
  return named.find((f) => !f.endsWith(fallback) && !fallback.endsWith(f)) ?? fallback
}

/** 块内逐行核对正文：对不上的行就是**内容**漂移（不只是行号），要人按 §11 看 */
function checkQuotedLines(block: Block, view: SourceView, rel: string, findings: Finding[]): void {
  // 空行与注释行不算正文：块头自己可能折行（`// from: …` 的续行），文档也允许留白
  for (const [offset, quoted] of block.body.entries()) {
    const text = quoted.trim()
    if (text.length === 0 || text.startsWith('//') || text.startsWith('…')) continue
    if (lineOf(view, quoted) !== null) continue
    findings.push({
      at: `docs/omp-sdk-reference.md:${block.line + offset + 1}`,
      detail: `这一行的正文在 ${rel} 里找不到：${text.slice(0, 90)}`,
    })
  }
}

/** 逐个块核对（或刷新）行号：`--write` 时返回到手的新头一行 */
function processBlocks(doc: readonly string[], findings: Finding[], cache: FileCache): Map<number, string> {
  const rewritten = new Map<number, string>()
  const seenMissing = new Set<string>()
  for (const block of parseBlocks(doc)) {
    const at = `docs/omp-sdk-reference.md:${block.line}`
    const anchor = parseHeader(block.header)
    if (anchor === null) {
      findings.push({ at, detail: `认不出这一行引用：${block.header}` })
      continue
    }
    const view = cache.get(anchor.root, anchor.rel)
    if (view === null) {
      const missing = `${anchor.root}/${anchor.rel}`
      if (!seenMissing.has(missing)) {
        seenMissing.add(missing)
        findings.push({ at, detail: `${missing} 在随包的 omp 里不存在` })
      }
      continue
    }
    if (anchor.tokenStart < 0) continue // 「整个文件」这类没有区间，跳过
    checkQuotedLines(block, view, anchor.rel, findings)
    const span = spanOf(view, block.body)
    if (span === null) {
      findings.push({ at, detail: `块内没有一行能在 ${anchor.rel} 里定位到（升级后形状变了？）` })
      continue
    }
    const stated = block.header.slice(anchor.tokenStart, anchor.tokenEnd)
    const fresh = rangeToken(span)
    if (squash(stated) === fresh) continue
    const head = block.header.slice(0, anchor.tokenStart)
    const tail = block.header.slice(anchor.tokenEnd)
    rewritten.set(block.line, `${head}${fresh}${tail}`)
    findings.push({ at, detail: `${anchor.rel} 写的是 ${stated}，实际是 ${fresh}` })
  }
  return rewritten
}

/** 全部 `名字:N` 锚点：名字必须在同一份源文件里，行号要对得上（`--write` 时一并刷新） */
function checkInlineRefs(
  doc: readonly string[],
  findings: Finding[],
  cache: FileCache,
  rewrite: (line: number, edit: (text: string) => string) => void,
): number {
  let checked = 0
  for (const ref of collectInlineRefs(doc)) {
    const text = doc[ref.line - 1] ?? ''
    const rel = fileForLine(text, ref.rel)
    const view = cache.get(ref.root, rel)
    if (view === null) continue
    const actual = lineOfName(view, ref.name, ref.number)
    const at = `docs/omp-sdk-reference.md:${ref.line}`
    if (actual === null) {
      findings.push({ at, detail: `\`${ref.name}\` 在 ${rel} 里找不到` })
      continue
    }
    checked++
    if (Math.abs(actual - ref.number) <= LINE_TOLERANCE) continue
    // 同一行上可能有多个锚点：每次都在「已经改过的样子」上再改一处
    rewrite(ref.line, (old) => old.replace(new RegExp(`(\`${ref.name}:)${ref.number}(?=\`)`), `$1${actual}`))
    findings.push({ at, detail: `\`${ref.name}:${ref.number}\` 实际在 ${rel}:${actual}` })
  }
  return checked
}

/**
 * 文档头：第一行的版本、第三行的包根路径都按随包那份 omp 现填（第二行是空行）。
 * 版本号只有 catalog 一个产地 —— 版本化目录名从 roots 的真路径现推，不写死字面量。
 */
function headerLines(doc: readonly string[], roots: Record<string, string>, version: string): Map<number, string> {
  const fresh = new Map<number, string>()
  const first = doc[0] ?? ''
  const freshFirst = first.replace(/^(# @oh-my-pi\/pi-coding-agent )\S+( —)/, `$1${version}$2`)
  if (freshFirst !== first) fresh.set(1, freshFirst)
  const pathLine = doc[HEADER_PATH_LINE - 1] ?? ''
  // 包根形如 …/.bun/@oh-my-pi+pi-ai@<版本>/node_modules/@oh-my-pi/pi-ai：往上数是「包名 / node_modules / 版本化目录」
  const versionedDir = (pkgRoot: string): string => path.basename(path.dirname(path.dirname(path.dirname(pkgRoot))))
  // 路径里写的只是 `@oh-my-pi+<包>@<版本>` 的版本段，前面的 `@oh-my-pi+<包>@` 原样留着
  const versionSegment = (dir: string): string => dir.replace(/^@oh-my-pi\+[^@]+@/, '')
  let freshPath = pathLine
  for (const [token, pkg] of Object.entries(HEADER_PACKAGES)) {
    const base = roots[token]
    if (base === undefined) continue
    const at = freshPath.indexOf(token)
    if (at === -1) continue
    const before = freshPath.slice(0, at + token.length)
    const after = freshPath.slice(at + token.length)
    const replaced = after.replace(
      new RegExp(`(= \`[^\`]*?@oh-my-pi\\+${pkg}@)[^/\\\\]+`),
      `$1${versionSegment(versionedDir(base))}`,
    )
    freshPath = before + replaced
  }
  if (freshPath !== pathLine) fresh.set(HEADER_PATH_LINE, freshPath)
  return fresh
}

function readPackageVersion(pkgRoot: string): string {
  const raw = readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')
  const parsed = JSON.parse(raw) as { version?: unknown }
  return typeof parsed.version === 'string' ? parsed.version : ''
}

const roots = ompRoots()
const missingRoots = Object.entries(roots).filter(([, dir]) => dir === '')
if (missingRoots.length > 0) {
  console.error(
    `[omp-sdk-doc] ❌ 随包安装的 @oh-my-pi/* 找不全（先 bun install）：${missingRoots.map(([k]) => k).join(', ')}`,
  )
  process.exit(1)
}
const packageRoot = roots.PKGROOT ?? ''

const original = readFileSync(DOC, 'utf8')
const lines = original.split('\n')
const installed = readPackageVersion(packageRoot)
const findings: Finding[] = []
// 文档行号（1 起）→ 到手的新内容：块头、块内 `名字:N`、文档头都写这一张表
const updated = new Map<number, string>()
const cache = makeCache(roots)
const rewritten = processBlocks(lines, findings, cache)
for (const [line, text] of rewritten) updated.set(line, text)
const inlineChecked = checkInlineRefs(lines, findings, cache, (line, edit) => {
  const base = updated.get(line) ?? lines[line - 1] ?? ''
  updated.set(line, edit(base))
})
for (const [line, text] of headerLines(lines, roots, installed)) updated.set(line, text)

// 同一行可能既要换行号又要换文档头：同一张表按「后写覆盖」合并即可
const finalLines = lines.map((text, index) => updated.get(index + 1) ?? text)
const headerTouched = updated.has(1) || updated.has(HEADER_PATH_LINE)

if (write) {
  writeFileSync(DOC, finalLines.join('\n'))
  console.log(
    `[omp-sdk-doc] ✍️ 刷新了 ${rewritten.size} 个行号区间与 ${updated.size - rewritten.size} 处锚点；` +
      '下面这些要人按 AGENTS.md §11 逐项核对：',
  )
  for (const f of findings) console.log(`  - ${f.at} ${f.detail}`)
  process.exit(0)
}

if (headerTouched) {
  findings.push({
    at: 'docs/omp-sdk-reference.md:1',
    detail: `文档头与随包的 omp ${installed} 对不上（头一行与包根路径都按随包那份现填，不许写死）`,
  })
}
if (findings.length > 0) {
  console.error('[omp-sdk-doc] ❌ docs/omp-sdk-reference.md 与随包的 omp 对不上：')
  for (const f of findings.slice(0, 40)) console.error(`  - ${f.at} ${f.detail}`)
  if (findings.length > 40) console.error(`  … 另有 ${findings.length - 40} 条`)
  console.error('  修法：bun run tooling/checks/omp-sdk-doc.ts --write（行号）＋ 按 AGENTS.md §11 核对内容')
  process.exit(1)
}
console.log(
  `[omp-sdk-doc] ✅ 头、${parseBlocks(lines).length} 个引用块与 ${inlineChecked} 处 \`名字:N\` 都对得上随包的 omp`,
)
