import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from '@typescript/typescript6'
import { type ImportRecord, importsOf, sources } from './imports.ts'
import { FRAMEWORK_SPECIFIERS } from './layering.ts'
import type { Violation } from './policies.ts'
import type { Manifest, Workspace } from './workspace.ts'

export interface SourceUnit {
  readonly file: string
  readonly code: string
  readonly options: ts.CompilerOptions
}
const testFile = (file: string): boolean =>
  /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|[/\\]__tests__[/\\])/.test(file)
const declarationFile = (file: string): boolean => /\.d\.[cm]?ts$/.test(file)
const canonicalOf = (host: ts.ModuleResolutionHost, file: string): string =>
  path.resolve(host.realpath?.(file) ?? file)

const jsxMarker = (node: ts.Node): boolean =>
  ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)

/* import()/require() 的实参：undefined 表示不是动态加载，null 表示无法静态解析。 */
const literalLoadOf = (node: ts.Node): string | null | undefined => {
  if (
    !ts.isCallExpression(node) ||
    !(
      node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require')
    )
  ) {
    return undefined
  }
  const argument = node.arguments[0]
  return argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : null
}

/* new URL(..., import.meta.url)：undefined 表示不是该形态，null 表示目标无法静态解析。 */
const metaUrlAssetOf = (node: ts.Node): string | null | undefined => {
  if (
    !ts.isNewExpression(node) ||
    !ts.isIdentifier(node.expression) ||
    node.expression.text !== 'URL'
  ) {
    return undefined
  }
  const target = node.arguments?.[0]
  const base = node.arguments?.[1]
  if (
    base === undefined ||
    !ts.isPropertyAccessExpression(base) ||
    base.name.text !== 'url' ||
    !ts.isMetaProperty(base.expression)
  ) {
    return undefined
  }
  return target !== undefined && ts.isStringLiteralLike(target) ? target.text : null
}

function edgeOf(
  file: string,
  record: ImportRecord,
  unit: SourceUnit,
  records: ReadonlyMap<string, SourceUnit>,
  host: ts.ModuleResolutionHost,
  resolveEntry: (specifier: string) => string | undefined,
  reject: (policy: string, file: string, detail: string) => void,
): { readonly forbidden: string[]; readonly target?: string } {
  const specifier = record.specifier
  const forbidden: string[] = []
  if (
    FRAMEWORK_SPECIFIERS.some((name) => specifier === name || specifier.startsWith(`${name}/`)) ||
    specifier.startsWith('@tauri-apps/')
  ) {
    forbidden.push(specifier)
  }
  const resolved = ts.resolveModuleName(specifier, file, unit.options, host).resolvedModule
  if (resolved === undefined) {
    if (specifier.startsWith('.')) {
      const asset = fileURLToPath(new URL(specifier, pathToFileURL(file)))
      if (!host.fileExists(asset)) {
        reject('resolved-file-dependencies', file, `Unresolved relative dependency: ${specifier}`)
      }
    } else if (specifier.startsWith('@poietica/')) {
      const entry = resolveEntry(specifier)
      if (entry === undefined || !host.fileExists(entry)) {
        reject(
          'resolved-file-dependencies',
          file,
          `Unresolved workspace public entry: ${specifier}`,
        )
      }
    }
    return { forbidden }
  }
  const target = canonicalOf(host, resolved.resolvedFileName)
  if (!record.typeOnly && testFile(target)) {
    reject('production-does-not-import-tests', file, specifier)
  }
  if (!record.typeOnly && records.has(target) && !declarationFile(target)) {
    return { forbidden, target }
  }
  return { forbidden }
}

function scanUnit(
  file: string,
  unit: SourceUnit,
  records: ReadonlyMap<string, SourceUnit>,
  host: ts.ModuleResolutionHost,
  resolveEntry: (specifier: string) => string | undefined,
  reject: (policy: string, file: string, detail: string) => void,
): { readonly outgoing: Set<string>; readonly forbidden: string[] } {
  const outgoing = new Set<string>()
  const forbidden: string[] = []
  const imports: ImportRecord[] = importsOf(file, unit.code)
  const visit = (node: ts.Node): void => {
    if (jsxMarker(node) && !forbidden.includes('JSX')) {
      forbidden.push('JSX')
    }
    if (literalLoadOf(node) === null) {
      reject(
        'opaque-module-load',
        file,
        'Dynamic module loads must have a statically resolvable literal.',
      )
    }
    const asset = metaUrlAssetOf(node)
    if (asset === null) {
      reject(
        'opaque-module-load',
        file,
        'URLs rooted at import.meta.url must expose their source dependency.',
      )
    } else if (asset?.startsWith('.')) {
      imports.push({ file, specifier: asset })
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, unit.code, ts.ScriptTarget.Latest, true))
  for (const record of imports) {
    const edge = edgeOf(file, record, unit, records, host, resolveEntry, reject)
    forbidden.push(...edge.forbidden)
    if (edge.target !== undefined) {
      outgoing.add(edge.target)
    }
  }
  return { outgoing, forbidden }
}

export function analyzeSourceFiles(
  root: string,
  units: readonly SourceUnit[],
  host: ts.ModuleResolutionHost,
  headless: readonly string[] = [],
  entries: ReadonlyMap<string, Workspace> = new Map<string, Workspace>(),
): Violation[] {
  const records = new Map(units.map((unit) => [canonicalOf(host, unit.file), unit]))
  const edges = new Map<string, Set<string>>()
  const blocked = new Map<string, string[]>()
  const violations: Violation[] = []
  const reject = (policy: string, file: string, detail: string): void => {
    violations.push({ policy, where: path.relative(root, file), detail })
  }
  const resolveEntry = (specifier: string): string | undefined => {
    const name = specifier.split('/').slice(0, 2).join('/')
    const workspace = entries.get(name)
    if (workspace === undefined) {
      return undefined
    }
    const subpath = specifier.slice(name.length)
    const target = workspace.manifest.exports?.[subpath === '' ? '.' : `.${subpath}`]
    return target === undefined ? undefined : path.resolve(root, workspace.directory, target)
  }
  for (const [file, unit] of records) {
    const scan = scanUnit(file, unit, records, host, resolveEntry, reject)
    edges.set(file, scan.outgoing)
    blocked.set(file, scan.forbidden)
  }
  const visited = new Set<string>()
  const active = new Set<string>()
  const stack: string[] = []
  const walk = (file: string): void => {
    if (active.has(file)) {
      const route = [...stack.slice(stack.indexOf(file)), file]
      reject(
        'runtime-file-cycle',
        file,
        route.map((item) => path.relative(root, item)).join(' -> '),
      )
      return
    }
    if (visited.has(file)) {
      return
    }
    active.add(file)
    stack.push(file)
    for (const target of edges.get(file) ?? []) {
      walk(target)
    }
    stack.pop()
    active.delete(file)
    visited.add(file)
  }
  for (const file of records.keys()) {
    walk(file)
  }
  for (const entry of headless) {
    const start = canonicalOf(host, entry)
    if (!records.has(start)) {
      reject(
        'headless-public-entry',
        start,
        'The declared headless entry is not a production source file.',
      )
      continue
    }
    const seen = new Set<string>()
    const pending = [start]
    while (pending.length > 0) {
      const file = pending.pop()
      if (file === undefined || seen.has(file)) {
        continue
      }
      seen.add(file)
      for (const dependency of blocked.get(file) ?? []) {
        reject('headless-public-entry', file, `${path.relative(root, start)} reaches ${dependency}`)
      }
      pending.push(...(edges.get(file) ?? []))
    }
  }
  return violations
}

function compilerOptions(root: string): (file: string) => ts.CompilerOptions {
  const cache = new Map<string, ts.ParsedCommandLine>()
  function read(configFile: string): ts.ParsedCommandLine {
    const absolute = path.resolve(configFile)
    const held = cache.get(absolute)
    if (held !== undefined) {
      return held
    }
    const source = ts.readConfigFile(absolute, ts.sys.readFile)
    if (source.error !== undefined) {
      throw new Error(ts.flattenDiagnosticMessageText(source.error.messageText, '\n'))
    }
    const parsed = ts.parseJsonConfigFileContent(
      source.config,
      ts.sys,
      path.dirname(absolute),
      undefined,
      absolute,
    )
    const errors = parsed.errors.filter((error) => error.code !== 18003)
    if (errors.length > 0) {
      throw new Error(
        errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n'),
      )
    }
    cache.set(absolute, parsed)
    return parsed
  }
  const defaults = read(path.join(root, 'tsconfig.base.json')).options
  return (file) => {
    const nearest = ts.findConfigFile(path.dirname(file), ts.sys.fileExists)
    if (nearest === undefined) {
      return defaults
    }
    const visited = new Set<string>()
    const match = (configFile: string): ts.CompilerOptions | undefined => {
      const absolute = path.resolve(configFile)
      if (visited.has(absolute)) {
        return undefined
      }
      visited.add(absolute)
      const config = read(absolute)
      if (config.fileNames.some((name) => path.resolve(name) === path.resolve(file))) {
        return config.options
      }
      for (const reference of config.projectReferences ?? []) {
        const referenced = ts.sys.directoryExists(reference.path)
          ? path.join(reference.path, 'tsconfig.json')
          : reference.path
        const options = match(referenced)
        if (options !== undefined) {
          return options
        }
      }
      return undefined
    }
    return { ...defaults, ...(match(nearest) ?? read(nearest).options) }
  }
}

export async function fileGraph(
  root: string,
  workspaces: readonly Workspace[],
): Promise<Violation[]> {
  const optionsFor = compilerOptions(root)
  const units: SourceUnit[] = []
  for (const directory of ['apps', 'packages']) {
    for (const file of await sources(path.join(root, directory))) {
      if (!testFile(file) && !declarationFile(file)) {
        units.push({ file, code: await readFile(file, 'utf8'), options: optionsFor(file) })
      }
    }
  }
  const headless: string[] = []
  for (const workspace of workspaces) {
    const manifest = workspace.manifest as Manifest & {
      poietica?: { headless?: readonly string[] }
    }
    for (const entry of manifest.poietica?.headless ?? []) {
      const target = manifest.exports?.[entry]
      if (target === undefined) {
        throw new Error(`Headless entry has no public export: ${workspace.name}:${entry}`)
      }
      headless.push(path.resolve(root, workspace.directory, target))
    }
  }
  const entries = new Map<string, Workspace>(
    workspaces.map((workspace) => [workspace.name, workspace] as const),
  )
  return analyzeSourceFiles(root, units, ts.sys, headless, entries)
}
