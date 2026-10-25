/**
 * conversation/shared 的原始 import 边界：相对 import 解析后离开 shared、进入区域目录就拒绝。
 * depcruise 的 resolved 规则负责正常穿透；这个闸门也覆盖会解析到不存在文件的假相对路径。
 * 用法：bun run tooling/checks/conversation-shared-imports.ts（由 bun run lint 调用）。
 */
import path from 'node:path'
import { type CallExpression, type Expression, parseSync } from '@swc/core'

const ROOT = path.resolve(import.meta.dir, '../..')
const SHARED = 'features/conversation/src/ui/shared'
const AREA = /^features\/conversation\/src\/ui\/(threads|composer|timeline|session|status|home|setup)\//
const SKIP = /(^|\/)(__tests__\/|[^/]+\.test\.tsx?$)/

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function callExpression(node: Record<string, unknown>): CallExpression | null {
  return node.type === 'CallExpression' && 'callee' in node && 'arguments' in node
    ? (node as unknown as CallExpression)
    : null
}

function importedPath(call: CallExpression): string | null {
  if (call.callee.type !== 'Import') return null
  const expression: Expression | undefined = call.arguments[0]?.expression
  return expression?.type === 'StringLiteral' ? expression.value : null
}

export function sharedAreaImportViolations(source: string, fileName: string): string[] {
  const ast = parseSync(source, { syntax: 'typescript', tsx: fileName.endsWith('x') })
  const violations: string[] = []

  function inspect(specifier: string): void {
    if (!specifier.startsWith('.')) return
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fileName), specifier))
    if (AREA.test(resolved)) violations.push(`${fileName}  ${specifier}`)
  }

  for (const item of ast.body) {
    if (
      item.type === 'ImportDeclaration' ||
      item.type === 'ExportNamedDeclaration' ||
      item.type === 'ExportAllDeclaration'
    ) {
      if (item.source !== undefined) inspect(item.source.value)
    }
  }
  function visit(node: unknown): void {
    if (!isRecord(node)) return
    const specifier = callExpression(node)
    if (specifier !== null) {
      const imported = importedPath(specifier)
      if (imported !== null) inspect(imported)
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit)
      else visit(value)
    }
  }
  visit(ast)
  return violations
}

const files: string[] = []
for (const entry of new Bun.Glob(`${SHARED}/**/*.{ts,tsx}`).scanSync({ cwd: ROOT, onlyFiles: true })) {
  const file = entry.replace(/\\/g, '/')
  if (!SKIP.test(file)) files.push(file)
}
const violations: string[] = []
for (const file of files) {
  violations.push(...sharedAreaImportViolations(await Bun.file(path.join(ROOT, file)).text(), file))
}
if (violations.length > 0) {
  console.error(`conversation-shared-imports：${violations.length} 处 shared 反向穿透`)
  for (const violation of violations) console.error(`  ${violation}`)
  process.exit(1)
}
console.log(`conversation-shared-imports：通过（shared ${files.length} 份源码）`)
