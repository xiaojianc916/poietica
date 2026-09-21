import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from '@typescript/typescript6'

export type ImportRecord = {
  readonly file: string
  readonly specifier: string
  readonly typeOnly?: true
}
export type ValueBinding = { readonly specifier: string; readonly name: string }

/** 图里的一条环：从进入点绕回自己的那串节点。 */
export type Cycle = readonly string[]

/**
 * 有向图找环：一趟颜色 DFS，交回每条环的节点序列。
 *
 * 闸门里三处（工作区 import 图、manifest 图、文件依赖图）各写一遍这个算法，
 * 修一处 bug 要记得修三处。`reported` 去重：同一个强连通分量会被多个入口撞见，
 * 不去重就会把同一条环报很多遍。
 */
export function cyclesIn(graph: ReadonlyMap<string, ReadonlySet<string>>): Cycle[] {
  const state = new Map<string, 'open' | 'closed'>()
  const trail: string[] = []
  const reported = new Set<string>()
  const found: Cycle[] = []

  const visit = (node: string): void => {
    const seen = state.get(node)

    if (seen === 'closed') {
      return
    }

    if (seen === 'open') {
      const cycle = [...trail.slice(trail.indexOf(node)), node]
      const key = cycle.join(' -> ')

      if (!reported.has(key)) {
        reported.add(key)
        found.push(cycle)
      }

      return
    }

    state.set(node, 'open')
    trail.push(node)

    for (const next of graph.get(node) ?? []) {
      visit(next)
    }

    trail.pop()
    state.set(node, 'closed')
  }

  for (const node of graph.keys()) {
    visit(node)
  }

  return found
}

const EXTENSIONS = ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']
const SKIP = new Set(['.turbo', 'coverage', 'dist', 'gen', 'node_modules', 'target'])

const notSkipped = (name: string): boolean => !SKIP.has(name)

/**
 * 迭代式遍历：每个条目过一遍 `visit`，目录由 `enter` 决定进不进。
 *
 * 闸门里六处规则各写一遍这段循环，改一条跳过清单就要改六处 —— 收敛到这里，
 * 跳过清单与路径怎么拼都只有一份。被 `enter` 拒掉的目录既不进待办也不交给 `visit`。
 */
async function walk(
  root: string,
  from: readonly string[],
  enter: (name: string) => boolean,
  visit: (child: string, isDirectory: boolean) => void,
): Promise<void> {
  const pending = [...from]

  while (pending.length > 0) {
    const current = pending.pop()

    if (current === undefined) {
      break
    }

    for (const entry of await readdir(path.join(root, current), { withFileTypes: true })) {
      const child = current === '.' ? entry.name : `${current}/${entry.name}`
      const directory = entry.isDirectory()

      if (directory) {
        if (!enter(entry.name)) {
          continue
        }

        pending.push(child)
      }

      visit(child, directory)
    }
  }
}

/** 文件清单，相对 root 的正斜杠路径。 */
export async function walkFiles(
  root: string,
  from: readonly string[],
  keep: (relative: string) => boolean,
  enter: (name: string) => boolean = notSkipped,
): Promise<string[]> {
  const found: string[] = []

  await walk(root, from, enter, (child, directory) => {
    if (!directory && keep(child)) {
      found.push(child)
    }
  })

  return found.sort()
}

/** 目录清单，相对 root 的正斜杠路径。 */
export async function walkDirectories(
  root: string,
  from: readonly string[],
  enter: (name: string) => boolean = notSkipped,
): Promise<string[]> {
  const found: string[] = []

  await walk(root, from, enter, (child, directory) => {
    if (directory) {
      found.push(child)
    }
  })

  return found.sort()
}

/** 源码文件的遍历：绝对目录进，绝对路径出。 */
export async function sources(directory: string): Promise<string[]> {
  const found = await walkFiles(directory, ['.'], (file) =>
    EXTENSIONS.some((extension) => file.endsWith(extension)),
  )

  return found.map((file) => path.join(directory, file)).sort()
}

/** Type-only edges are explicit; dynamic imports are always runtime edges.
 *
 * `parsed` 让调用方把已经建好的语法树递进来：同一个文件既读 import 又走查别的
 * 节点时，各建一棵树就是把同一份源码解析两遍。
 */
export function importsOf(file: string, code: string, parsed?: ts.SourceFile): ImportRecord[] {
  const tree = parsed ?? ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const records: ImportRecord[] = []
  const capture = (node: ts.Node | undefined, typeOnly = false): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) {
      records.push(
        typeOnly ? { file, specifier: node.text, typeOnly: true } : { file, specifier: node.text },
      )
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause
      const bindings = clause?.namedBindings
      const typeOnly =
        clause?.isTypeOnly === true ||
        (clause?.name === undefined &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((binding) => binding.isTypeOnly))
      capture(node.moduleSpecifier, typeOnly)
    } else if (ts.isExportDeclaration(node)) {
      const clause = node.exportClause
      const typeOnly =
        node.isTypeOnly ||
        (clause !== undefined &&
          ts.isNamedExports(clause) &&
          clause.elements.length > 0 &&
          clause.elements.every((binding) => binding.isTypeOnly))
      capture(node.moduleSpecifier, typeOnly)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      capture(node.moduleReference.expression, node.isTypeOnly)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      capture(node.argument.literal, true)
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
    ) {
      capture(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return records
}

export function valueBindingsOf(file: string, code: string): ValueBinding[] {
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const found: ValueBinding[] = []
  for (const node of tree.statements) {
    if (
      !ts.isImportDeclaration(node) ||
      !ts.isStringLiteralLike(node.moduleSpecifier) ||
      node.importClause === undefined ||
      node.importClause.isTypeOnly
    ) {
      continue
    }
    const specifier = node.moduleSpecifier.text
    const bindings = node.importClause.namedBindings
    if (bindings !== undefined && ts.isNamedImports(bindings)) {
      for (const binding of bindings.elements) {
        if (!binding.isTypeOnly) {
          found.push({ specifier, name: binding.propertyName?.text ?? binding.name.text })
        }
      }
    } else if (bindings !== undefined && ts.isNamespaceImport(bindings)) {
      found.push({ specifier, name: '*' })
    }
  }
  return found
}

export async function readImports(root: string, roots: readonly string[]): Promise<ImportRecord[]> {
  const records: ImportRecord[] = []
  for (const directory of roots) {
    for (const file of await sources(path.join(root, directory))) {
      const relative = path.relative(root, file).split(path.sep).join('/')
      records.push(...importsOf(relative, await readFile(file, 'utf8')))
    }
  }
  return records
}
