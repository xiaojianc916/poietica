import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { cyclesIn, type ImportRecord, walkFiles } from './imports.ts'
import {
  CARGO_RINGS,
  DOMAIN_CONTRACT_IMPORTS,
  FORBIDDEN_DIRECTORY_NAMES,
  FRAMEWORK_FREE_PACKAGES,
  FRAMEWORK_SPECIFIERS,
  HOST_AGNOSTIC_CRATES,
  HOST_AWARE_PACKAGES,
  ringOf,
  TYPESCRIPT_RINGS,
  typeScriptDependencyAllowed,
  UNLAYERED_DIRECTORIES,
} from './layering.ts'
import { dependenciesOf } from './manifest-graph.ts'
import type { Crate, Workspace } from './workspace.ts'

export type Violation = { readonly policy: string; readonly where: string; readonly detail: string }

export const CONTRACT_BINDINGS = 'packages/contract/src/generated/ipc-bindings.ts'

/** 目录门面：只转发，不持有依赖。 */
const FACADE = /(?:^|\/)index\.[cm]?[jt]sx?$/

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
        detail: `Unknown workspace: ${target}`,
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
    if (!typeScriptDependencyAllowed(owner.name, target)) {
      violations.push({
        policy: 'layer-direction',
        where: record.file,
        detail: `${owner.name} cannot depend on ${target}`,
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

  return cyclesIn(edges).map((cycle) => ({
    policy: 'no-cycles',
    where: 'workspace graph',
    detail: cycle.join(' -> '),
  }))
}

/**
 * 包内目录之间的运行时环。
 *
 * 文件级的 runtime-file-cycle 抓不到这一族：两个目录互相依赖时，只要其中一头经由
 * 自己的 index.ts 转发，文件图上就没有环 —— facade 把环藏起来了。而「A 目录与 B
 * 目录互相依赖」是真实的耦合缺陷，与有没有 facade 无关。判例：surface 与它自己的
 * composer / threads / timeline 三族曾经互指（皮肤文件住在 composer 里，而三族都读它）。
 *
 * 单元的定义：包内 src/ 下的文件取父目录，src/ 根下的散文件各自成单元。后者是刻意
 * 的 —— 把 src/failure.ts 与 src/index.ts 并成一个节点，会把「子目录引用根下的叶子」
 * 误报成「子目录引用 facade」，而那是两回事。
 *
 * facade 只转发，不持有依赖：把它算成边的起点，它对自己子目录的每一次转发都会变成
 * 一条反向边，于是每个有 index.ts 的包都自成一环。所以 facade 不作为起点；作为终点
 * 时归它所在的目录 —— 依赖一个门面就是依赖那个目录。
 */
export function intraPackageCycles(
  imports: readonly ImportRecord[],
  workspaces: readonly Workspace[],
): Violation[] {
  const owners = workspaces
    .map((workspace) => `${workspace.directory}/src/`)
    .sort((left, right) => right.length - left.length)
  const unitOf = (file: string): string | undefined => {
    const owner = owners.find((candidate) => file.startsWith(candidate))

    if (owner === undefined) {
      return undefined
    }

    const local = file.slice(owner.length)
    const segments = local.split('/')

    return segments.length === 1 ? `${owner}${local}` : `${owner}${segments.slice(0, -1).join('/')}`
  }
  const edges = new Map<string, Set<string>>()

  for (const record of imports) {
    /* 跨包边归 layer-direction 与 no-cycles；这里只看一个包自己的目录怎么摆。 */
    if (!record.specifier.startsWith('.') || FACADE.test(record.file)) {
      continue
    }

    const from = unitOf(record.file)

    if (from === undefined) {
      continue
    }

    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(record.file), record.specifier),
    )
    const to = unitOf(resolved)

    if (to === undefined || to === from) {
      continue
    }

    const held = edges.get(from) ?? new Set<string>()
    held.add(to)
    edges.set(from, held)
  }

  return cyclesIn(edges).map((cycle) => ({
    policy: 'intra-package-cycles',
    where: cycle[0] ?? '',
    detail: `包内目录互相依赖：${cycle.join(' -> ')}`,
  }))
}

/** Rust 源码里的 `crate::<第一段>`：use 声明与代码里的路径引用都算一条边。 */
const RUST_CRATE_REFERENCE = /\bcrate::([a-z_][a-z0-9_]*)/g

/** 注释里的例子不是依赖。整行注释与行尾注释都剥掉。 */
const stripRustComments = (source: string): string =>
  source
    .split('\n')
    .map((line) => {
      const cut = line.indexOf('//')

      return cut < 0 ? line : line.slice(0, cut)
    })
    .join('\n')

/**
 * Rust 源文件到它所属的模块单元。
 *
 * 单元是 `src/` 下的父目录：`src/session/rest.rs` 与 `src/session/mod.rs` 同属
 * `session`，`src/http.rs` 自成 `http`。`crate::X` 的 X 就是单元名，所以边不需要
 * 解析文件路径 —— Rust 的模块路径本身就是地址。
 *
 * `lib.rs` 与 `main.rs` 是 crate 根，不是一个模块：返回 undefined。
 */
function rustModuleOf(local: string): string | undefined {
  const segments = local.split('/')

  if (segments.length === 1) {
    return local === 'lib.rs' || local === 'main.rs' ? undefined : local.replace(/\.rs$/, '')
  }

  return segments[0]
}

/** 一个 crate 里，模块单元之间的 `crate::X` 边。 */
async function rustModuleEdges(
  root: string,
  directory: string,
  files: readonly string[],
): Promise<Map<string, Set<string>>> {
  const prefix = `${directory}/src/`
  /* 逐文件记账：一个模块目录下有多份文件，按模块名收会互相覆盖。 */
  const units = files
    .map((file) => ({ file, from: rustModuleOf(file.slice(prefix.length)) }))
    .filter((unit): unit is { file: string; from: string } => unit.from !== undefined)
  const modules = new Set(units.map((unit) => unit.from))
  const edges = new Map<string, Set<string>>()

  for (const { file, from } of units) {
    const source = stripRustComments(await readFile(path.join(root, file), 'utf8'))

    for (const match of source.matchAll(RUST_CRATE_REFERENCE)) {
      const to = match[1] ?? ''

      if (to === from || !modules.has(to)) {
        continue
      }

      const held = edges.get(from) ?? new Set<string>()
      held.add(to)
      edges.set(from, held)
    }
  }

  return edges
}

/**
 * Rust crate 内部模块之间的环。
 *
 * `crateDependencyDirection` 只看 crate 之间的边（数据来自 cargo metadata），
 * crate 自己的模块怎么摆它看不见。判例：agent-client 的 connection 与 session 曾经
 * 互指 —— 重连逻辑（会话恢复）住在 connection 里，而 session 又要拨号与发帧。
 *
 * crate 目录取自 cargo metadata 的 manifest_path，不由 crate 名推：判例是
 * poietica-extension-native 住在 crates/extension，按名字推会静默空转。
 */
export async function rustModuleCycles(
  root: string,
  crates: readonly Crate[],
): Promise<Violation[]> {
  const violations: Violation[] = []

  for (const { directory } of crates) {
    /* 目录不在就跳过：workspace 之外的路径依赖没有源码可扫。 */
    if (!(await present(path.join(root, directory, 'src')))) {
      continue
    }

    const files = await walkFiles(root, [`${directory}/src`], (file) => file.endsWith('.rs'))

    for (const cycle of cyclesIn(await rustModuleEdges(root, directory, files))) {
      violations.push({
        policy: 'rust-module-cycles',
        where: `${directory}/src`,
        detail: `crate 内模块互相依赖：${cycle.join(' -> ')}`,
      })
    }
  }

  return violations
}

/** 跨包只走 exports 声明的入口，包根与子路径同样检查。 */
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

    const target = byName.get(packageOf(record.specifier))

    if (target === undefined) {
      continue
    }

    const subpath = segments.length === 2 ? '.' : `./${segments.slice(2).join('/')}`

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
        detail: `${owner.name} 未登记为允许触碰原生层的包`,
      })
    }
  }

  return violations
}

/** Runtime transport stays private; declared domain contracts admit only erased type edges. */
export function transportContractIsAdapterPrivate(
  imports: readonly ImportRecord[],
  workspaces: readonly Workspace[],
): Violation[] {
  const runtimeConsumers = new Set(['@poietica/contract', '@poietica/native-bridge'])
  const violations: Violation[] = []
  for (const workspace of workspaces) {
    if (
      !runtimeConsumers.has(workspace.name) &&
      DOMAIN_CONTRACT_IMPORTS[workspace.name] === undefined &&
      workspace.manifest.dependencies?.['@poietica/contract'] !== undefined
    ) {
      violations.push({
        policy: 'transport-contract-is-adapter-private',
        where: `${workspace.directory}/package.json`,
        detail: 'Undeclared domain contract dependency.',
      })
    }
  }
  for (const record of imports) {
    if (packageOf(record.specifier) !== '@poietica/contract') {
      continue
    }
    const owner = ownerOf(record.file, workspaces)
    if (owner === undefined || runtimeConsumers.has(owner.name)) {
      continue
    }
    const publicContract = DOMAIN_CONTRACT_IMPORTS[owner.name]
    if (record.typeOnly !== true || record.specifier !== publicContract) {
      violations.push({
        policy: 'transport-contract-is-adapter-private',
        where: record.file,
        detail: 'Only the declared type-only domain contract may cross this boundary.',
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

/** 路径在不在。存在性只问一句就够，别把整份内容读进来。 */
export const present = async (target: string): Promise<boolean> => {
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
  const files = await walkFiles(root, ['tools'], (file) => file.endsWith('.ts'))

  for (const file of files) {
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

/**
 * 词汇镜像必须与它的产地逐字一致。
 *
 * `packages/problem` 不许 import 传输契约（transport-contract-is-adapter-private），
 * 所以 Code/Category/Retryability 三个并集只能手抄一份 —— 手抄就要有门禁，
 * 否则 Rust 加一个错误码，TS 侧永远不知道，而两边都编译通过。
 */
export async function problemVocabularyMirrorsSource(
  root: string,
  codeSource: string,
  categorySource: string,
  retrySource: string,
): Promise<Violation[]> {
  const camel = (name: string): string =>
    name.charAt(0).toLowerCase() + name.slice(1).replace(/_(.)/g, (_, c: string) => c.toUpperCase())

  const members = (source: string, name: string): string[] => {
    const body = new RegExp(`pub enum ${name} \\{([^}]*)\\}`).exec(source)?.[1] ?? ''

    return [...body.matchAll(/^\s*([A-Z][A-Za-z0-9_]*),\s*$/gm)].map((match) =>
      camel(match[1] ?? ''),
    )
  }

  const mirror = await readFile(path.join(root, 'packages/problem/src/model.ts'), 'utf8')
  const violations: Violation[] = []

  for (const [name, source] of [
    ['Code', codeSource],
    ['Category', categorySource],
    ['Retryability', retrySource],
  ] as const) {
    const declared = members(source, name)
    const union = new RegExp(`export type ${name} =([^\\n]*(?:\\n\\s*\\|[^\\n]*)*)`).exec(mirror)
    const copied = [...(union?.[1] ?? '').matchAll(/'([A-Za-z0-9_]+)'/g)].map(
      (match) => match[1] ?? '',
    )

    for (const member of declared) {
      if (!copied.includes(member)) {
        violations.push({
          policy: 'problem-vocabulary-mirrors-source',
          where: 'packages/problem/src/model.ts',
          detail: `${name} 缺成员 ${member}，crates/problem 里有`,
        })
      }
    }

    for (const member of copied) {
      if (!declared.includes(member)) {
        violations.push({
          policy: 'problem-vocabulary-mirrors-source',
          where: 'packages/problem/src/model.ts',
          detail: `${name} 多出成员 ${member}，crates/problem 里没有`,
        })
      }
    }
  }

  return violations
}

/** 包只能 import 自己在 package.json 里声明过的 @poietica/*。 */
export function declaredDependenciesOnly(
  imports: readonly ImportRecord[],
  workspaces: readonly Workspace[],
): Violation[] {
  /* manifest 已经在手上（Workspace 的一个字段）：再读一遍盘就是把同一份 JSON 解析两次。 */
  const declared = new Map(
    workspaces.map((workspace) => [workspace.name, dependenciesOf(workspace.manifest)]),
  )

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
