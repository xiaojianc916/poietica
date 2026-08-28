import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

export type ImportRecord = { readonly file: string; readonly specifier: string }

const EXTENSIONS = ['.ts', '.tsx']
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

/** `<T>(x) => x` 在 tsx 下被当成标签开头，所以 loader 按扩展名给，不共用一份。 */
const loaderOf = (file: string): 'ts' | 'tsx' => (file.endsWith('.tsx') ? 'tsx' : 'ts')

export async function readImports(root: string, roots: readonly string[]): Promise<ImportRecord[]> {
  /* 两个 loader 各建一份：scanImports 的类型签名不收第二个参数，而 tsx 会把
  `<T>(x) => x` 当成标签；按扩展名挑解析器，运行时与类型都过。 */
  const transpilers = {
    ts: new Bun.Transpiler({ loader: 'ts' }),
    tsx: new Bun.Transpiler({ loader: 'tsx' }),
  }
  const records: ImportRecord[] = []

  for (const directory of roots) {
    for (const file of await sources(path.join(root, directory))) {
      const code = await readFile(file, 'utf8')

      for (const found of transpilers[loaderOf(file)].scanImports(visible(code))) {
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
