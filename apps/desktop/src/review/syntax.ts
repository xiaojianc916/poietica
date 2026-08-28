import type { DiffFile, DiffPiece, DiffRow, DiffRowKind, PieceColor } from '@poietica/file-diff'
import { type BundledLanguage, codeToTokensWithThemes } from 'shiki'

/*
 * 语法着色。
 *
 * 一行的语法不由这一行决定，所以按文件整侧分词：新侧是 context+added，旧侧是
 * context+removed，跨行的字符串与块注释因此不会断。分词与取色交给 shiki（TextMate
 * 语法，与 VS Code 同一套），这里只把词元切回行的片段。纯函数，能在 Node 里单测。
 */
const THEMES = { dark: 'github-dark', light: 'github-light' } as const
/* 后缀到语法 id：id 由 BundledLanguage 约束，写错在 typecheck 就报。 */
const LANGUAGES: Readonly<Record<string, BundledLanguage>> = {
  cjs: 'javascript',
  css: 'css',
  html: 'html',
  js: 'javascript',
  json: 'json',
  jsonc: 'json',
  jsx: 'jsx',
  md: 'markdown',
  mjs: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'shellscript',
  toml: 'toml',
  ts: 'typescript',
  tsx: 'tsx',
  yaml: 'yaml',
  yml: 'yaml',
}
type Lines = Awaited<ReturnType<typeof codeToTokensWithThemes>>
type Token = Lines[number][number]
/** 给每一行的片段染色；语法不认识的文件原样交回。 */
export async function paint(files: readonly DiffFile[]): Promise<readonly DiffFile[]> {
  return await Promise.all(files.map((file) => painted(file)))
}
async function painted(file: DiffFile): Promise<DiffFile> {
  const lang = languageOf(file.path)
  if (lang === null || file.binary) {
    return file
  }
  const sides = [sideOf(file, 'added'), sideOf(file, 'removed')]
  const tokens = await Promise.all(
    sides.map((side) => codeToTokensWithThemes(side.code, { lang, themes: THEMES })),
  )
  const found = new Map<DiffRow, readonly DiffPiece[]>()
  for (const [index, side] of sides.entries()) {
    const lines = tokens[index] ?? []
    for (const [line, row] of side.rows.entries()) {
      found.set(row, coloured(row.pieces, lines[line] ?? []))
    }
  }
  return { ...file, rows: repainted(file.rows, found) }
}
function languageOf(path: string): BundledLanguage | null {
  const dot = path.lastIndexOf('.')
  const suffix = dot > path.lastIndexOf('/') + 1 ? path.slice(dot + 1).toLowerCase() : ''
  return LANGUAGES[suffix] ?? null
}
/* 一侧的完整正文：跳掉对侧独有的行，行序即文件序。 */
function sideOf(
  file: DiffFile,
  skip: DiffRowKind,
): { readonly rows: readonly DiffRow[]; readonly code: string } {
  const rows = rowsOf(file).filter((row) => row.kind !== skip)
  return { code: rows.map((row) => row.text).join('\n'), rows }
}
/* 折起来的行也算：语法状态不能因为折叠而断。 */
function rowsOf(file: DiffFile): readonly DiffRow[] {
  const found: DiffRow[] = []
  for (const row of file.rows) {
    if (row.kind === 'gap') {
      found.push(...row.hidden)
      continue
    }
    found.push(row)
  }
  return found
}
/* 词元与片段是同一行的两套切分：求交，取词元的色、留片段的强调。 */
function coloured(pieces: readonly DiffPiece[], line: readonly Token[]): readonly DiffPiece[] {
  const found: DiffPiece[] = []
  let token = 0
  let eaten = 0
  let at = 0
  for (const piece of pieces) {
    let rest = piece.text
    while (rest !== '') {
      const current = line[token]
      if (current === undefined) {
        found.push({ at, color: null, emphasis: piece.emphasis, text: rest })
        at += rest.length
        rest = ''
        continue
      }
      const room = current.content.length - eaten
      if (room <= 0) {
        token += 1
        eaten = 0
        continue
      }
      const taken = rest.slice(0, Math.min(room, rest.length))
      found.push({ at, color: colorOf(current), emphasis: piece.emphasis, text: taken })
      at += taken.length
      eaten += taken.length
      rest = rest.slice(taken.length)
    }
  }
  return found.length === 0 ? pieces : found
}
function colorOf(token: Token): PieceColor | null {
  const light = token.variants['light']?.color
  const dark = token.variants['dark']?.color
  return light === undefined || dark === undefined ? null : { dark, light }
}
function repainted(
  rows: readonly DiffRow[],
  found: ReadonlyMap<DiffRow, readonly DiffPiece[]>,
): readonly DiffRow[] {
  return rows.map((row) => {
    if (row.kind === 'gap') {
      return { ...row, hidden: repainted(row.hidden, found) }
    }
    const pieces = found.get(row)
    return pieces === undefined ? row : { ...row, pieces }
  })
}
