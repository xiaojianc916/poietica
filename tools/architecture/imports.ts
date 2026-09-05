import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from '@typescript/typescript6'

export type ImportRecord = { readonly file: string; readonly specifier: string }
export type ValueBinding = { readonly specifier: string; readonly name: string }

const EXTENSIONS = ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx']
const SKIP = new Set(['.turbo', 'coverage', 'dist', 'gen', 'node_modules', 'target'])

/** Reads syntax without rewriting comments, strings, type imports, or shebangs. */
export function importsOf(file: string, code: string): ImportRecord[] {
  const tree = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true)
  const records: ImportRecord[] = []
  const capture = (node: ts.Node | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) {
      records.push({ file, specifier: node.text })
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      capture(node.moduleSpecifier)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      capture(node.moduleReference.expression)
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      capture(node.argument.literal)
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

async function sources(directory: string): Promise<string[]> {
  const found: string[] = []
  const pending = [directory]

  while (pending.length > 0) {
    const current = pending.pop()

    if (current === undefined) {
      break
    }

    const entries = await readdir(current, { withFileTypes: true })

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
