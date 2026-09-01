import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import type { ImportRecord } from './imports.ts'
import {
  CARGO_RINGS,
  FORBIDDEN_DIRECTORY_NAMES,
  FRAMEWORK_FREE_PACKAGES,
  FRAMEWORK_SPECIFIERS,
  HOST_AGNOSTIC_CRATES,
  HOST_AWARE_PACKAGES,
  ringOf,
  TYPESCRIPT_RINGS,
  UNLAYERED_DIRECTORIES,
} from './layering.ts'
import type { Crate, Workspace } from './workspace.ts'

export type Violation = { readonly policy: string; readonly where: string; readonly detail: string }

export const CONTRACT_BINDINGS = 'packages/contract/src/generated/ipc-bindings.ts'

const scoped = (specifier: string): boolean => specifier.startsWith('@poietica/')

const packageOf = (specifier: string): string => specifier.split('/').slice(0, 2).join('/')

function ownerOf(file: string, workspaces: readonly Workspace[]): Workspace | undefined {
  let owner: Workspace | undefined

  for (const workspace of workspaces) {
    if (!file.startsWith(`${workspace.directory}/`)) {
      continue
    }

    if (owner === undefined || workspace.directory.length > owner.directory.length) {
      owner = workspace
    }
  }

  return owner
}

const layered = (): string[] => TYPESCRIPT_RINGS.flatMap((ring) => [...ring.members])

const layeredCrates = (): string[] => CARGO_RINGS.flatMap((ring) => [...ring.members])

/** 没有未登记的包与 crate，也没有登记了却不存在的成员。 */
export function everythingIsRegistered(
  workspaces: readonly Workspace[],
  crates: readonly Crate[],
): Violation[] {
  const violations: Violation[] = []
  const packages = layered()
  const names = workspaces.map((workspace) => workspace.name)

  for (const workspace of workspaces) {
    if (UNLAYERED_DIRECTORIES.includes(workspace.directory)) {
      continue
    }

    if (!packages.includes(workspace.name)) {
      violations.push({
        policy: 'everything-is-registered',
        where: workspace.directory,
        detail: `${workspace.name} 未在 TYPESCRIPT_RINGS 登记`,
      })
    }
  }

  for (const member of packages) {
    if (!names.includes(member)) {
      violations.push({
        policy: 'everything-is-registered',
        where: 'tools/architecture/layering.ts',
        detail: `分层表登记了不存在的包 ${member}`,
      })
    }
  }

  const crateNames = crates.map((crate) => crate.name)

  for (const crate of crates) {
    if (!layeredCrates().includes(crate.name)) {
      violations.push({
        policy: 'everything-is-registered',
        where: 'Cargo.toml',
        detail: `${crate.name} 未在 CARGO_RINGS 登记`,
      })
    }
  }

  for (const member of layeredCrates()) {
    if (!crateNames.includes(member)) {
      violations.push({
        policy: 'everything-is-registered',
        where: 'tools/architecture/layering.ts',
        detail: `分层表登记了不存在的 crate ${member}`,
      })
    }
  }

  return violations
}

/** 只允许高环指向低环。 */
export function layerDirection(
  imports: readonly ImportRecord[],
  workspaces: readonly Workspace[],
): Violation[] {
  const violations: Violation[] = []
  const names = new Set(workspaces.map((workspace) => workspace.name))

  for (const record of imports) {
    if (!scoped(record.specifier)) {
      continue
    }

    const target = packageOf(record.specifier)
    const owner = ownerOf(record.file, workspaces)

    if (!names.has(target)) {
      violations.push({
        policy: 'layer-direction',
        where: record.file,
        detail: `引用了不存在的工作区 ${target}`,
      })
      continue
    }

    if (
      owner === undefined ||
      UNLAYERED_DIRECTORIES.includes(owner.directory) ||
      owner.name === target
    ) {
      continue
    }

    const from = ringOf(TYPESCRIPT_RINGS, owner.name)
    const to = ringOf(TYPESCRIPT_RINGS, target)

    if (from < 0 || to < 0) {
      continue
    }

    if (to === from) {
      violations.push({
        policy: 'layer-direction',
        where: record.file,
        detail: `${owner.name} 与 ${target} 同环，同环之间不许有边`,
      })
      continue
    }

    if (to > from) {
      violations.push({
        policy: 'layer-direction',
        where: record.file,
        detail: `${owner.name} 指向了更高的环 ${target}`,
      })
    }
  }

  return violations
}

export function noCycles(
  imports: readonly ImportRecord[],
  workspaces: readonly Workspace[],
): Violation[] {
  const edges = new Map<string, Set<string>>()

  for (const record of imports) {
    if (!scoped(record.specifier)) {
      continue
    }

    const owner = ownerOf(record.file, workspaces)
    const target = packageOf(record.specifier)

    if (owner === undefined || owner.name === target) {
      continue
    }

    const next = edges.get(owner.name) ?? new Set<string>()
    next.add(target)
    edges.set(owner.name, next)
  }

  const violations: Violation[] = []
  const state = new Map<string, 'open' | 'closed'>()
  const trail: string[] = []

  const visit = (node: string): void => {
    const seen = state.get(node)

    if (seen === 'closed') {
      return
    }

    if (seen === 'open') {
      violations.push({
        policy: 'no-cycles',
        where: 'workspace graph',
        detail: [...trail.slice(trail.indexOf(node)), node].join(' -> '),
      })
      return
    }

    state.set(node, 'open')
    trail.push(node)

    for (const next of edges.get(node) ?? []) {
      visit(next)
    }

    trail.pop()
    state.set(node, 'closed')
  }

  for (const workspace of workspaces) {
    visit(workspace.name)
  }

  return violations
}

/** 跨包只走公开入口：深路径必须是对方 exports 里白纸黑字写过的。 */
export function publicEntryOnly(
  imports: readonly ImportRecord[],
  workspaces: readonly Workspace[],
): Violation[] {
  const violations: Violation[] = []
  const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]))

  for (const record of imports) {
    if (!scoped(record.specifier)) {
      continue
    }

    const segments = record.specifier.split('/')

    if (segments.length <= 2) {
      continue
    }

    const target = byName.get(packageOf(record.specifier))

    if (target === undefined) {
      continue
    }

    const subpath = `./${segments.slice(2).join('/')}`

    if (target.manifest.exports?.[subpath] === undefined) {
      violations.push({
        policy: 'public-entry-only',
        where: record.file,
        detail: `${record.specifier} 不在 ${target.name} 的 exports 里`,
      })
    }
  }

  return violations
}

/** 相对路径不许跨出自己的包。 */
export function relativeImportsStayHome(
  imports: readonly ImportRecord[],
  workspaces: readonly Workspace[],
): Violation[] {
  const violations: Violation[] = []

  for (const record of imports) {
    if (!record.specifier.startsWith('.')) {
      continue
    }

    const owner = ownerOf(record.file, workspaces)

    if (owner === undefined) {
      continue
    }

    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(record.file), record.specifier),
    )

    if (!resolved.startsWith(`${owner.directory}/`)) {
      violations.push({
        policy: 'no-escaping-relative-imports',
        where: record.file,
        detail: `${record.specifier} 跨出了 ${owner.directory}`,
      })
    }
  }

  return violations
}

/** 只有登记过的包允许直接用 Tauri 客户端 API。 */
export function nativeAccessIsDeclared(
  imports: readonly ImportRecord[],
  workspaces: readonly Workspace[],
): Violation[] {
  const violations: Violation[] = []

  for (const record of imports) {
    if (!record.specifier.startsWith('@tauri-apps/')) {
      continue
    }

    const owner = ownerOf(record.file, workspaces)

    if (owner === undefined || UNLAYERED_DIRECTORIES.includes(owner.directory)) {
      continue
    }

    if (!HOST_AWARE_PACKAGES.includes(owner.name)) {
      violations.push({
        policy: 'native-access-is-declared',
        where: record.file,
        detail: `${owner.name} 未登记为允许触碎原生层的包`,
      })
    }
  }

  return violations
}

/** 生成传输契约只允许桥消费；领域与组合层都不得认识它。 */
export function transportContractIsAdapterPrivate(
  imports: readonly ImportRecord[],
  workspaces: readonly Workspace[],
): Violation[] {
  const allowed = new Set(['@poietica/contract', '@poietica/native-bridge'])
  const violations: Violation[] = []

  for (const workspace of workspaces) {
    if (
      !allowed.has(workspace.name) &&
      workspace.manifest.dependencies?.['@poietica/contract'] !== undefined
    ) {
      violations.push({
        policy: 'transport-contract-is-adapter-private',
        where: `${workspace.directory}/package.json`,
        detail: `${workspace.name} 在 manifest 中依赖传输契约`,
      })
    }
  }

  for (const record of imports) {
    if (packageOf(record.specifier) !== '@poietica/contract') {
      continue
    }
    const owner = ownerOf(record.file, workspaces)
    if (owner !== undefined && !allowed.has(owner.name)) {
      violations.push({
        policy: 'transport-contract-is-adapter-private',
        where: record.file,
        detail: `${owner.name} 绕过领域端口直连传输契约`,
      })
    }
  }

  return violations
}

/** 词汇与领域包里不许出现 UI 框架。 */
export function frameworkFreeVocabulary(
  imports: readonly ImportRecord[],
  workspaces: readonly Workspace[],
): Violation[] {
  const violations: Violation[] = []

  for (const record of imports) {
    if (!FRAMEWORK_SPECIFIERS.includes(record.specifier)) {
      continue
    }

    const owner = ownerOf(record.file, workspaces)

    if (owner !== undefined && FRAMEWORK_FREE_PACKAGES.includes(owner.name)) {
      violations.push({
        policy: 'framework-free-vocabulary',
        where: record.file,
        detail: `${owner.name} 引入了 ${record.specifier}`,
      })
    }
  }

  return violations
}

/** 环序只管方向；同环能力之间允许组合，无环由 cargo 自己保证。 */
export function crateDependencyDirection(crates: readonly Crate[]): Violation[] {
  const violations: Violation[] = []
  const members = new Set(crates.map((crate) => crate.name))

  for (const crate of crates) {
    const from = ringOf(CARGO_RINGS, crate.name)

    if (from < 0) {
      continue
    }

    for (const dependency of crate.dependencies) {
      if (!members.has(dependency)) {
        continue
      }

      const to = ringOf(CARGO_RINGS, dependency)

      if (to > from) {
        violations.push({
          policy: 'layer-direction',
          where: crate.name,
          detail: `指向了更高的环 ${dependency}`,
        })
      }
    }
  }

  return violations
}

export function cratesStayHostAgnostic(crates: readonly Crate[]): Violation[] {
  const violations: Violation[] = []

  for (const crate of crates) {
    if (!HOST_AGNOSTIC_CRATES.includes(crate.name)) {
      continue
    }

    for (const dependency of crate.dependencies) {
      if (dependency === 'tauri' || dependency.startsWith('tauri-')) {
        violations.push({
          policy: 'crates-stay-host-agnostic',
          where: crate.name,
          detail: `依赖了 ${dependency}`,
        })
      }
    }
  }

  return violations
}

export function capabilityScopedDirectories(directories: readonly string[]): Violation[] {
  return directories
    .filter((directory) => FORBIDDEN_DIRECTORY_NAMES.includes(path.posix.basename(directory)))
    .map((directory) => ({
      policy: 'capability-scoped-directories',
      where: directory,
      detail: '目录按技术类型命名，不回答它是什么能力',
    }))
}

const present = async (target: string): Promise<boolean> => {
  try {
    await stat(target)
    return true
  } catch {
    return false
  }
}

/** 契约生成物只能有一处，并且写入方与校验方都盯着它。 */
export async function singleGeneratedContract(
  root: string,
  exportBindings: string,
  generatedDirectories: readonly string[],
): Promise<Violation[]> {
  const violations: Violation[] = []
  const gate = await readFile(path.join(root, 'tools/contract/check-generated.ts'), 'utf8').catch(
    () => '',
  )

  if (!(await present(path.join(root, CONTRACT_BINDINGS)))) {
    violations.push({
      policy: 'single-generated-contract',
      where: CONTRACT_BINDINGS,
      detail: '生成物不在契约包里',
    })
  }

  for (const directory of generatedDirectories) {
    if (directory !== 'packages/contract/src/generated') {
      violations.push({
        policy: 'single-generated-contract',
        where: directory,
        detail: '第二处生成物目录',
      })
    }
  }

  if (!exportBindings.includes(CONTRACT_BINDINGS)) {
    violations.push({
      policy: 'single-generated-contract',
      where: 'apps/desktop/src-tauri/src/ipc/export_bindings.rs',
      detail: '导出路径没指向契约包',
    })
  }

  if (gate === '') {
    violations.push({
      policy: 'single-generated-contract',
      where: 'tools/contract/check-generated.ts',
      detail: '漂移门禁脚本不存在',
    })
  } else if (!gate.includes(CONTRACT_BINDINGS)) {
    violations.push({
      policy: 'single-generated-contract',
      where: 'tools/contract/check-generated.ts',
      detail: '门禁没盯着契约包的生成物',
    })
  }

  return violations
}

export async function manifestScriptsResolve(
  root: string,
  manifests: ReadonlyArray<{ where: string; scripts: Record<string, string> }>,
): Promise<Violation[]> {
  const violations: Violation[] = []

  for (const manifest of manifests) {
    for (const [name, command] of Object.entries(manifest.scripts)) {
      for (const token of command.split(/\s+/)) {
        if (!token.includes('/') || !/\.(ts|tsx|mjs|js)$/.test(token)) {
          continue
        }

        if (await present(path.join(root, token))) {
          continue
        }

        violations.push({
          policy: 'manifest-scripts-resolve',
          where: manifest.where,
          detail: `${name} 指向不存在的 ${token}`,
        })
      }
    }
  }

  return violations
}

/** 点名的脚本必须存在：manifest 之外，源码里 spawn 出去的路径同样是一处声明。 */
const INVOKED_SCRIPT = /(?:apps|packages|tools)\/[\w./-]+\.(?:tsx|ts|mjs)/g

export async function invokedScriptsResolve(root: string): Promise<Violation[]> {
  const violations: Violation[] = []
  const pending = ['tools']
  const files: string[] = []

  while (pending.length > 0) {
    const current = pending.pop()

    if (current === undefined) {
      break
    }

    for (const entry of await readdir(path.join(root, current), { withFileTypes: true })) {
      const child = `${current}/${entry.name}`

      if (entry.isDirectory()) {
        pending.push(child)
        continue
      }

      if (child.endsWith('.ts')) {
        files.push(child)
      }
    }
  }

  for (const file of files.sort()) {
    const source = await readFile(path.join(root, file), 'utf8')

    for (const match of source.matchAll(INVOKED_SCRIPT)) {
      const named = match[0] ?? ''

      if (named.length === 0 || (await present(path.join(root, named)))) {
        continue
      }

      violations.push({
        policy: 'invoked-scripts-resolve',
        where: file,
        detail: `点名了不存在的 ${named}`,
      })
    }
  }

  return violations
}

/** 跨语言单一来源：错误码在 Rust 定义，句子在前端目录，两边必须刚好对上。 */
export async function problemCopyIsComplete(
  root: string,
  codeSource: string,
): Promise<Violation[]> {
  const declared = [...codeSource.matchAll(/"(problem\.[A-Za-z0-9]+)"/g)].map(
    (match) => match[1] ?? '',
  )
  const loaded = (await import(
    pathToFileURL(path.join(root, 'packages/problem/src/copy.ts')).href
  )) as { PROBLEM_COPY: Record<string, string> }
  const catalog = Object.keys(loaded.PROBLEM_COPY)
  const violations: Violation[] = []

  for (const key of declared) {
    if (!catalog.includes(key)) {
      violations.push({
        policy: 'problem-copy-is-complete',
        where: 'packages/problem/src/copy.ts',
        detail: `缺文案 ${key}`,
      })
    }
  }

  for (const key of catalog) {
    if (!declared.includes(key)) {
      violations.push({
        policy: 'problem-copy-is-complete',
        where: 'packages/problem/src/copy.ts',
        detail: `多出文案 ${key}，crates/problem 里没有这个键`,
      })
    }
  }

  return violations
}

/** 包只能 import 自己在 package.json 里声明过的 @poietica/*。 */
export async function declaredDependenciesOnly(
  root: string,
  imports: readonly ImportRecord[],
  workspaces: readonly Workspace[],
): Promise<Violation[]> {
  const declared = new Map<string, Set<string>>()

  for (const workspace of workspaces) {
    const manifest = JSON.parse(
      await readFile(path.join(root, workspace.directory, 'package.json'), 'utf8'),
    ) as {
      dependencies?: Record<string, string>
      devDependencies?: Record<string, string>
      peerDependencies?: Record<string, string>
    }

    declared.set(
      workspace.name,
      new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
        ...Object.keys(manifest.peerDependencies ?? {}),
      ]),
    )
  }

  const violations: Violation[] = []

  for (const record of imports) {
    if (!scoped(record.specifier)) {
      continue
    }

    const owner = ownerOf(record.file, workspaces)
    const target = packageOf(record.specifier)

    if (owner === undefined || owner.name === target) {
      continue
    }

    if (!declared.get(owner.name)?.has(target)) {
      violations.push({
        policy: 'declared-dependencies-only',
        where: record.file,
        detail: `${owner.name} 没有声明 ${target}`,
      })
    }
  }

  return violations
}
