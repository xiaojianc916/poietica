/**
 * 样式边界闸门（S1/S3/S4/S6/S7/S9/S10）：把设计令牌收敛的结果锁住，以后只降不升。
 *
 * 规则出处：tidy-poietica-frontend skill（frontend-map §6/§7/§10/§12.6 与 SKILL.md Phase 5）。
 * 例外一律写成下面的 EXCEPTIONS（精确路径 + 预算 + 理由），预算等于收尾时的实际计数：
 * 例外命中数只许降（降到 0 就把条目删掉），不许升。理由在 refactor-log 的 Q 条目里。
 *
 * 用法：`bun run tooling/checks/style-boundaries.ts`（由 `bun run lint` 调用）
 */
import path from 'node:path'

const ROOT = path.resolve(import.meta.dir, '../..')
const TOKENS_DIR = 'packages/design-system/src/tokens'
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.bun-cache',
  '.tsbuild',
  '.probe-home',
  'dist',
  'out',
  'release',
  'coverage',
  'docs',
  '.scratch',
  'script',
])

/** 某条规则在某路径下的豁免：budget 是该路径当前实际命中数，只降不升。 */
interface Exception {
  readonly rule: string
  readonly path: string
  readonly budget: number
  readonly note: string
}

const EXCEPTIONS: readonly Exception[] = [
  // S1：属性值里的字面色（受既有声明或上游迁移保护）。
  {
    rule: 'S1',
    path: 'features/conversation/src/ui/status/todo/todo-panel.css',
    budget: 1,
    note: '兜底里的字面，与 S9 同一处、同一既有声明',
  },
  {
    rule: 'S1',
    path: 'features/conversation/src/ui/home/mascot',
    budget: 1,
    note: '吉祥物是 V-01 逐字迁移的上游运行时，逐字等价优先于套本仓规则（见 refactor-log 偏差 V-01）',
  },
  // S3：palette 直读。banner 那两处恒深卡上的蓝，等 Q55 裁决（新增角色令牌或长期例外）。
  {
    rule: 'S3',
    path: 'packages/design-system/src/control/banner.css',
    budget: 2,
    note: 'Q55：恒深卡面上的进度填充与动作蓝，两主题同值',
  },
  // S7：tokens 目录外的 :root 块。
  {
    rule: 'S7',
    path: 'packages/design-system/src/scrollbar.css',
    budget: 1,
    note: '滚动条几何令牌，xterm-theme.ts 按名读（baseline 已知例外）',
  },
  {
    rule: 'S7',
    path: 'packages/design-system/src/surface.css',
    budget: 1,
    note: '基础表面的圆角别名（baseline 已知例外）',
  },
  {
    rule: 'S7',
    path: 'apps/desktop/src/renderer/styles.css',
    budget: 3,
    note: '平台令牌两块 + prefers-color-scheme 首帧兜底一块（baseline 已知例外，不动）',
  },
  // S9：令牌兜底。
  {
    rule: 'S9',
    path: 'packages/design-system/src/control/banner.css',
    budget: 2,
    note: 'banner-contract.test.ts 钉住 --ui-banner-hold 兜底',
  },
  {
    rule: 'S9',
    path: 'packages/design-system/src/prose/prose.css',
    budget: 1,
    note: 'Shiki 注入的 --cp-tok 缺省即继承（prose.css 头注）',
  },
  {
    rule: 'S9',
    path: 'features/conversation/src/ui/timeline/minimap/conversation-minimap.css',
    budget: 1,
    note: '--cp-rail-card-y 由 use-rail-pointer.ts 运行时写入',
  },
  {
    rule: 'S9',
    path: 'features/conversation/src/ui/status/todo/todo-panel.css',
    budget: 5,
    note: '文件头既有声明：换挂载点时不解析成空值',
  },
]

/** S10 的全仓预算（lucide 文件里的死图标属性）：现状即基准，Q53 裁决前只防新增。
 * 口径：凡 import lucide-react 的 TSX 文件里的 size={ / strokeWidth={ 属性全算——比 skill
 * 盘点脚本的「图标元素」口径略宽（当前多 1 处非图标的 size prop），预算按闸门口径登记。 */
const S10_BUDGET = { size: 0, strokeWidth: 0 }

const cssFiles: string[] = []
const tsxFiles: string[] = []
for (const entry of new Bun.Glob('**/*.{css,tsx}').scanSync({ cwd: ROOT, onlyFiles: true })) {
  const rel = entry.replace(/\\/g, '/')
  if (rel.split('/').some((part: string) => SKIP_DIRS.has(part))) continue
  if (rel.endsWith('.css')) cssFiles.push(rel)
  else tsxFiles.push(rel)
}

const violations: string[] = []
const exceptionUse = new Map<string, number>()

function report(rule: string, file: string, line: number, text: string): void {
  const exempt = EXCEPTIONS.find((e) => e.rule === rule && (file === e.path || file.startsWith(`${e.path}/`)))
  if (exempt) {
    const key = `${rule}:${exempt.path}`
    exceptionUse.set(key, (exceptionUse.get(key) ?? 0) + 1)
    return
  }
  violations.push(`${rule} ${file}:${line + 1}: ${text.trim()}`)
}

/** 去掉行注释（粗略：/* 与 // 之后；CSS 的 // 不合法但防御性处理）。 */
function stripComment(line: string): string {
  const idx = line.indexOf('/*')
  return idx === -1 ? line : line.slice(0, idx)
}

/** 字面色：hex、rgb/hsl、直接的 oklch()。color-mix()/light-dark() 是函数容器，包裹的字面会被内层模式自己命中。 */
const LITERAL_COLOR = /(#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(|\boklch\()/
const MASK_PROPS = /^(?:-webkit-)?mask/

/**
 * S7 只拦「整个选择器只由 :root 系列组成」的块（在全局挂变量的写法）；
 * `:root[data-theme='dark'] .x { --x: … }` 是 frontend-map §14.3 认可的主题分支写法，放行。
 */
const ROOT_ONLY_BLOCK =
  /^:root[^\s{,]*(?::not\(\[[^\]]+\]\))?\s*\{|^:root[^\s{,]*(?::not\(\[[^\]]+\]\))?\s*,\s*:root[^\s{,]*(?::not\(\[[^\]]+\]\))?\s*\{/

for (const file of cssFiles) {
  const inTokens = file.startsWith(TOKENS_DIR)
  const lines = (await Bun.file(path.join(ROOT, file)).text()).split('\n')
  for (const [index, raw] of lines.entries()) {
    const line = stripComment(raw)
    if (!line.trim()) continue
    const isVarDecl = /^\s*--[a-zA-Z0-9-]+\s*:/.test(line)
    const isDecl = /^\s*[-a-zA-Z]+\s*:/.test(line)

    // S1：令牌目录外的属性值里不写字面色；私有变量定义处（--x: …）是合法产地。
    if (!inTokens && !isVarDecl && isDecl && LITERAL_COLOR.test(line) && !MASK_PROPS.test(line.trim())) {
      // mask 是 alpha 遮罩不是视觉颜色（#000 是载体），豁免。
      report('S1', file, index, line)
    }
    // S3：palette 原色只在 tokens/ 内被引用。
    if (!inTokens && line.includes('var(--ui-palette-')) {
      report('S3', file, index, line)
    }
    // S4：项目 CSS 不读 Tailwind 投影（投影只给工具类）。
    if (
      line.includes('var(--color-') ||
      line.includes('var(--text-') ||
      line.includes('var(--font-') ||
      line.includes('var(--radius-') ||
      line.includes('var(--ease-')
    ) {
      // --font-* 的例外：无。--shadow-* 名字与组件私有变量（如 --workbench-shadow）可能相撞，只查投影真名。
      report('S4', file, index, line)
    }
    // S6：字面 z-index 只允许容器内部档（-1..4）；浮层栈序走 layers.css。
    const zMatch = /\bz-index:\s*(-?\d+)\s*;/.exec(line)
    const zValue = zMatch === null ? undefined : Number(zMatch[1])
    if (zValue !== undefined && (zValue < -1 || zValue > 4)) {
      report('S6', file, index, line)
    }
    // S7：tokens 目录外不写「只匹配 :root 的选择器块」（组件私有变量不上全局根）。
    if (!inTokens && ROOT_ONLY_BLOCK.test(line.trim())) {
      report('S7', file, index, line)
    }
    // S9：不给 --ui-*/--cp-* 写兜底（作用域错了兜底会静默生效）。
    if (/var\(--(?:ui|cp)-[a-zA-Z0-9-]+\s*,/.test(line) && !isVarDecl) {
      report('S9', file, index, line)
    }
  }
}

// S10：lucide 图标上的 size / strokeWidth 属性被 :where(svg) 压住，永不生效（Q53）。
// 只统计 import lucide-react 的文件里的属性写法，按全仓预算放行存量。
let s10Size = 0
let s10Stroke = 0
for (const file of tsxFiles) {
  const text = await Bun.file(path.join(ROOT, file)).text()
  if (!text.includes("from 'lucide-react'")) continue
  for (const [index, raw] of text.split('\n').entries()) {
    const line = stripComment(raw)
    if (/\babsoluteStrokeWidth=\{/.test(line) || /\bstrokeWidth=\{/.test(line)) s10Stroke += 1
    if (/\bsize=\{/.test(line)) s10Size += 1
    if ((/\bwidth=\{/.test(line) || /\bheight=\{/.test(line)) && /<svg[\s>]/.test(line)) {
      violations.push(`S10 ${file}:${index + 1}: ${line.trim()}`)
    }
  }
}
if (s10Size > S10_BUDGET.size)
  violations.push(`S10 全仓 lucide size 属性 ${s10Size} 处，超出预算 ${S10_BUDGET.size}（Q53 裁决前不得新增）`)
if (s10Stroke > S10_BUDGET.strokeWidth)
  violations.push(
    `S10 全仓 lucide strokeWidth 属性 ${s10Stroke} 处，超出预算 ${S10_BUDGET.strokeWidth}（Q53 裁决前不得新增）`,
  )

// 例外预算核对：命中数不得超过登记值。
for (const e of EXCEPTIONS) {
  const used = exceptionUse.get(`${e.rule}:${e.path}`) ?? 0
  if (used > e.budget) violations.push(`${e.rule} 例外超预算 ${e.path}：${used} > ${e.budget}（${e.note}）`)
}

if (violations.length > 0) {
  console.error(`style-boundaries：${violations.length} 处越界`)
  for (const v of violations) console.error(`  ${v}`)
  process.exit(1)
}

console.log(`style-boundaries：通过（CSS ${cssFiles.length} 份、TSX ${tsxFiles.length} 份；例外预算未超）`)
