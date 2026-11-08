/**
 * 「只减不增」计数闸门（架构设计 §23.1 / §24.2 P0；ADR-001、ADR-008 附带的过渡措施）。
 *
 * 四类存量问题现在还不能一次清零，但从这一版起**不许再多**：
 *
 * | 规则 | 数什么 | 对应 |
 * | --- | --- | --- |
 * | omp-deep-import | 指向 `@oh-my-pi/<包>/<子路径>` 的模块说明符（import / export from / import() / mock.module） | D1，§9.2 第 3 条 |
 * | english-ui-text | 生产代码里拿 omp 的英文界面文案做比较、前缀匹配或查表的字面量 | D1、D4，§9.1 Interaction Bridge |
 * | tool-payload-parsing | UI 里对 `unknown` 工具载荷的手写探测（view-kit 探针、`Record<string, unknown>` 断言） | D2，§7 |
 * | platform-branch | 平台能力模块之外的平台判断：`process.platform`、`'win32'`、`.exe`、PowerShell / cmd.exe | D9，§23.1 第 5 条 |
 *
 * 计数按「规则 × 文件」记在 ratchet-baseline.json：
 * - 某个文件某条规则比基线多 —— 失败（新增了问题，或者把问题搬到了新文件）；
 * - 比基线少 —— 也失败，提示跑 `--write` 收紧基线（不收紧的话，省下的额度会被下一次改动悄悄用掉）；
 * - `--write` 只接受收紧：任何一项变多都拒绝写入。确实要放宽（例如搬家后合并文件），手改基线 JSON 并在 PR 里说明。
 *
 * 只数生产代码：测试、测试夹具、testing 子入口、生成物不计。计数是启发式的（按行正则），
 * 目的是让趋势可见、阻止恶化，不是精确的语义分析。
 *
 * 用法：`bun run tooling/checks/ratchet.ts [--write]`（由 `bun run lint` 调用）
 */
import path from 'node:path'

export type RuleId = 'omp-deep-import' | 'english-ui-text' | 'tool-payload-parsing' | 'platform-branch'

export const RULES: readonly RuleId[] = [
  'omp-deep-import',
  'english-ui-text',
  'tool-payload-parsing',
  'platform-branch',
]

/** 规则 → 文件（仓库相对路径，`/` 分隔）→ 计数；只记计数 > 0 的项 */
export type Counts = Record<RuleId, Record<string, number>>

const ROOT = path.resolve(import.meta.dir, '../..')
const BASELINE = path.join(import.meta.dir, 'ratchet-baseline.json')
const SCAN_ROOTS = ['packages', 'features', 'apps']
const SKIP_DIRS = new Set([
  'node_modules',
  '.tsbuild',
  'dist',
  'out',
  'release',
  'coverage',
  '__tests__',
  'testing',
  'fixtures',
  'scripts',
])

/** 平台能力模块：只有这里可以写平台判断（D9 的平台层建成后放进来；现在为空） */
const PLATFORM_MODULES: readonly string[] = []

const DEEP_OMP = /(['"`])@oh-my-pi\/[\w.-]+\/[^'"`\s]+\1/g

/* 注释行与「给开发者看的」英文（断言、异常、日志）不算解析界面文案 */
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/
const DEV_TEXT = /\b(invariant|Error|DOMException|logger|log|console)\b[\w.]*\(|\.(debug|info|warn|error|describe)\(/
/*
 * 「解析英文文案」只数**拿英文去认东西**的写法，产品自己显示的英文标签不算：
 * - 比较 / 前后缀匹配 / case 分支里的英文（`=== 'Nothing to retry.'`、`startsWith('Approve ')`）；
 * - 以英文原句为键的翻译表（`['Fast mode enabled.', …]`、`'Available Tools': …`）；
 * - 存英文标签的大写常量（`const DENY_LABEL = 'Deny'`）；
 * - 含英文短语的正则字面量（`/^Fast mode is (\w+)\.$/`）。
 * 键盘键名（`event.key === 'Enter'`）不算。
 */
const EN = String.raw`[A-Z][a-z]+(?:[ :][A-Za-z0-9…'’/-]*)*[.:!?]?\s?`
const EN_COMPARE = new RegExp(
  String.raw`(?:[!=]==\s*|\b(?:startsWith|endsWith|includes|indexOf|lastIndexOf)\(\s*|\bcase\s+)(['"\`])${EN}\1`,
  'g',
)
/** 翻译表的键：`['原句', …]`、`'原句': …`；元组拆成多行时（上一行只有 `[`）也算 */
const EN_TABLE_KEY = /^\s*(?:\[\s*(['"`])[A-Z][a-z]+ [^'"`\n]*\1\s*,|(['"`])[A-Z][a-z]+ [^'"`\n]*\2\s*:)/g
const EN_TUPLE_HEAD = /^\s*(['"`])[A-Z][a-z]+ [^'"`\n]*\1\s*,/g
const EN_LABEL_CONST = /\bconst\s+[A-Z][A-Z0-9_]*\s*(?::\s*[\w<>[\], ]+)?=\s*(['"`])[A-Z][a-z]+(?: [^'"`]*)?\1/g
const EN_REGEX = /(?:^\s*|[(=,:[!&|?{;]\s*)\/(?![*/])\^?[^/\n<>]*[A-Z][a-z]+ [a-z]+[^/\n<>]*\/[gimsuy]*/g
const KEY_NAME = /\bkey\s*[!=]==|[!=]==\s*\w+\.key\b/
/** 键盘键名：`case 'Enter':` 之类不是界面文案 */
const KEY_NAMES =
  /(['"`])(?:Home|End|Enter|Escape|Tab|Backspace|Delete|Insert|Space|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Shift|Control|Alt|Meta|F\d{1,2})\1/g

const PAYLOAD_PROBE = /(?<![.\w])(bag|get|pick|numb|flag|list|strings|blocksOf|textOf|detailsOf|imagesOf)\(/g
const RECORD_UNKNOWN = /(?:as|satisfies|:)\s*Record<string,\s*unknown>/g

const PLATFORM =
  /\bprocess\.platform\b|\bos\.platform\(|['"`]win32['"`]|\.exe\b|\bpowershell(?:\.exe)?\b|\bpwsh\b|\bcmd\.exe\b/gi

function countMatches(line: string, re: RegExp): number {
  re.lastIndex = 0
  let n = 0
  while (re.exec(line) !== null) n++
  return n
}

function isUiFile(rel: string): boolean {
  return (
    /^features\/[^/]+\/src\/ui\//.test(rel) ||
    /^packages\/ui-[^/]+\//.test(rel) ||
    /^apps\/desktop\/src\/renderer\//.test(rel)
  )
}

/** 一个文件在各规则下的计数（纯函数，测试直接调用） */
export function countFile(source: string, rel: string): Partial<Record<RuleId, number>> {
  const out: Partial<Record<RuleId, number>> = {}
  const add = (rule: RuleId, n: number): void => {
    if (n > 0) out[rule] = (out[rule] ?? 0) + n
  }
  const ui = isUiFile(rel)
  const usesViewKit = ui && /from ['"][^'"]*view-kit['"]/.test(source)
  const platformAllowed = PLATFORM_MODULES.some((p) => rel === p || rel.startsWith(`${p}/`))
  let previous = ''
  for (const line of source.split('\n')) {
    const tupleOpened = previous.trim() === '['
    previous = line
    add('omp-deep-import', countMatches(line, DEEP_OMP))
    if (COMMENT_LINE.test(line)) continue
    if (!DEV_TEXT.test(line)) {
      add('english-ui-text', countEnglish(line, tupleOpened))
    }
    if (ui) {
      add(
        'tool-payload-parsing',
        countMatches(line, RECORD_UNKNOWN) + (usesViewKit ? countMatches(line, PAYLOAD_PROBE) : 0),
      )
    }
    if (!platformAllowed) add('platform-branch', countMatches(line, PLATFORM))
  }
  return out
}

function countEnglish(line: string, tupleOpened: boolean): number {
  return (
    (KEY_NAME.test(line) ? 0 : countMatches(line, EN_COMPARE) - countMatches(line, KEY_NAMES)) +
    countMatches(line, EN_TABLE_KEY) +
    (tupleOpened ? countMatches(line, EN_TUPLE_HEAD) : 0) +
    countMatches(line, EN_LABEL_CONST) +
    countMatches(line, EN_REGEX)
  )
}

export function emptyCounts(): Counts {
  return { 'omp-deep-import': {}, 'english-ui-text': {}, 'tool-payload-parsing': {}, 'platform-branch': {} }
}

export interface Comparison {
  /** 比基线多的项（含基线里没有的新文件） */
  readonly grown: string[]
  /** 比基线少、需要收紧的项 */
  readonly shrunk: string[]
}

export function compare(baseline: Counts, current: Counts): Comparison {
  const grown: string[] = []
  const shrunk: string[] = []
  for (const rule of RULES) {
    const base = baseline[rule] ?? {}
    const now = current[rule] ?? {}
    for (const file of new Set([...Object.keys(base), ...Object.keys(now)])) {
      const b = base[file] ?? 0
      const c = now[file] ?? 0
      if (c > b) grown.push(`${rule}  ${file}: ${b} → ${c}`)
      else if (c < b) shrunk.push(`${rule}  ${file}: ${b} → ${c}`)
    }
  }
  return { grown: grown.sort(), shrunk: shrunk.sort() }
}

function sortCounts(counts: Counts): Counts {
  const out = emptyCounts()
  for (const rule of RULES) {
    for (const file of Object.keys(counts[rule]).sort()) out[rule][file] = counts[rule][file] as number
  }
  return out
}

function skipFile(rel: string): boolean {
  return (
    rel.split('/').some((part) => SKIP_DIRS.has(part)) ||
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel) ||
    /\.d\.ts$/.test(rel)
  )
}

async function scan(): Promise<Counts> {
  const counts = emptyCounts()
  for (const root of SCAN_ROOTS) {
    for (const entry of new Bun.Glob('**/*.{ts,tsx,js,jsx,mjs,cjs}').scanSync({
      cwd: path.join(ROOT, root),
      onlyFiles: true,
    })) {
      const rel = `${root}/${entry.replace(/\\/g, '/')}`
      if (skipFile(rel)) continue
      const found = countFile(await Bun.file(path.join(ROOT, rel)).text(), rel)
      for (const rule of RULES) {
        const n = found[rule]
        if (n !== undefined) counts[rule][rel] = n
      }
    }
  }
  return sortCounts(counts)
}

function totals(counts: Counts): string {
  return RULES.map((rule) => `${rule} ${Object.values(counts[rule]).reduce((a, b) => a + b, 0)}`).join('，')
}

async function main(): Promise<void> {
  const write = process.argv.includes('--write')
  const current = await scan()
  const file = Bun.file(BASELINE)
  const baseline: Counts = (await file.exists())
    ? { ...emptyCounts(), ...((await file.json()) as Partial<Counts>) }
    : emptyCounts()
  const { grown, shrunk } = compare(baseline, current)
  if (write) {
    if (grown.length > 0 && (await file.exists())) {
      console.error('拒绝写入：下列计数比基线多（只减不增；确需放宽请手改 ratchet-baseline.json 并说明原因）：')
      for (const g of grown) console.error(`  ${g}`)
      process.exit(1)
    }
    await Bun.write(BASELINE, `${JSON.stringify(current, null, 2)}\n`)
    console.log(`✔ 已写入基线（${totals(current)}）`)
    return
  }
  reportComparison(grown, shrunk)
  console.log(`✔ 只减不增闸门通过（${totals(current)}）`)
}

function reportComparison(grown: string[], shrunk: string[]): void {
  if (grown.length > 0) {
    console.error('只减不增闸门：下列计数比基线多 —— 新代码请走正式边界（见 docs/adr）：')
    for (const g of grown) console.error(`  ${g}`)
  }
  if (shrunk.length > 0) {
    console.error('下列计数比基线少，请运行 `bun run check:ratchet --write` 收紧基线：')
    for (const s of shrunk) console.error(`  ${s}`)
  }
  if (grown.length > 0 || shrunk.length > 0) process.exit(1)
}

if (import.meta.main) await main()
