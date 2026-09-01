import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export type ImportRecord = { readonly file: string; readonly specifier: string }

const EXTENSIONS = ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']
const SKIP = new Set(['.turbo', 'coverage', 'dist', 'gen', 'node_modules', 'target'])

/**
 * 把类型导入显给解析器看：这一步是归一，判据仍由解析器给。
 *
 * 只改 `import type` 与 `export type { … } from` 这两种「带 from」的形式。
 * `export type X = …` 是类型别名，去掉 type 就成了 `export X = …` —— 语法错误，
 * 解析器当场炸在第一行别名上。
 */
const visible = (code: string): string =>
  code.replace(/\bimport type /g, 'import ').replace(/\bexport type (\{|\*)/g, 'export $1')

/** bun 1.4 的 scanImports 把首行 shebang 当语法错误，而 tools/ 下的脚本入口都是 `#!/usr/bin/env bun`。 */
const unwrap = (code: string): string => code.replace(/^#!.*/, '')

type SourceLoader = 'js' | 'jsx' | 'ts' | 'tsx'

const loaderOf = (file: string): SourceLoader => {
  switch (path.extname(file)) {
    case '.jsx':
      return 'jsx'
    case '.tsx':
      return 'tsx'
    case '.cts':
    case '.mts':
    case '.ts':
      return 'ts'
    default:
      return 'js'
  }
}

export async function readImports(root: string, roots: readonly string[]): Promise<ImportRecord[]> {
  /* 两个 loader 各建一份：scanImports 的类型签名不收第二个参数，而 tsx 会把
  `<T>(x) => x` 当成标签；按扩展名挑解析器，运行时与类型都过。 */
  const transpilers = {
    js: new Bun.Transpiler({ loader: 'js' }),
    jsx: new Bun.Transpiler({ loader: 'jsx' }),
    ts: new Bun.Transpiler({ loader: 'ts' }),
    tsx: new Bun.Transpiler({ loader: 'tsx' }),
  }
  const records: ImportRecord[] = []

  for (const directory of roots) {
    for (const file of await sources(path.join(root, directory))) {
      const code = await readFile(file, 'utf8')

      for (const found of transpilers[loaderOf(file)].scanImports(visible(unwrap(code)))) {
        records.push({
          file: path.relative(root, file).split(path.sep).join('/'),
          specifier: found.path,
        })
      }
    }
  }

  return records
}

async function sources(directory: string): Promise<string[]> {
  const found: string[] = []
  const pending = [directory]

  while (pending.length > 0) {
    const current = pending.pop()

    if (current === undefined) {
      break
    }

    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const child = path.join(current, entry.name)

      if (entry.isDirectory()) {
        if (!SKIP.has(entry.name)) {
          pending.push(child)
        }

        continue
      }

      if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
        found.push(child)
      }
    }
  }

  return found.sort()
}
