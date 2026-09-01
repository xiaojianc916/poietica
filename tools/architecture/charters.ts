/** 模块宪章判据：每条规则问的都是"这件事归谁管"，判据是标识符与图，不是措辞。 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

import { CARGO_RINGS, UNLAYERED_DIRECTORIES } from './layering.ts'
import type { Violation } from './policies.ts'
import type { Crate, Workspace } from './workspace.ts'

/** 方案文档写的是目标形态，不是现状：它不参与"点名的东西必须存在"。 */
const SKIP = new Set([
  '.git',
  '.github',
  '.turbo',
  'Architecture',
  'coverage',
  'dist',
  'gen',
  'node_modules',
  'target',
])

/** 这个文件本身列举了禁用标记，不能把自己算成违规。 */
const SELF = 'tools/architecture/charters.ts'

const BACKTICK = String.fromCharCode(96)

async function walk(
  root: string,
  from: readonly string[],
  suffixes: readonly string[],
): Promise<string[]> {
  const found: string[] = []
  const pending = [...from]

  while (pending.length > 0) {
    const current = pending.pop()

    if (current === undefined) {
      break
    }

    const entries = await readdir(path.join(root, current), { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      if (SKIP.has(entry.name)) {
        continue
      }

      const child = current === '.' ? entry.name : `${current}/${entry.name}`

      if (entry.isDirectory()) {
        pending.push(child)
        continue
      }

      if (suffixes.some((suffix) => entry.name.endsWith(suffix))) {
        found.push(child)
      }
    }
  }

  return found.sort()
}

const rust = (root: string): Promise<string[]> => walk(root, ['apps', 'crates'], ['.rs'])

async function holding(root: string, files: readonly string[], needle: string): Promise<string[]> {
  const hits: string[] = []

  for (const file of files) {
    if ((await readFile(path.join(root, file), 'utf8')).includes(needle)) {
      hits.push(file)
    }
  }

  return hits
}

/** 路径是路径，store 是 store：定义处不算持有。 */
const PATHS = 'apps/desktop/src-tauri/src/paths.rs'

/** 组合根开库：三个偏好库都在 setup 里打开。 */
const COMPOSITION_ROOT = 'apps/desktop/src-tauri/src/composition.rs'

/** 每个偏好库的命令面：开库归组合根，读写归它自己那一个文件。 */
const STORE_FACES = [
  { store: 'settings_store', face: 'apps/desktop/src-tauri/src/ipc/commands/settings.rs' },
  { store: 'agents_store', face: 'apps/desktop/src-tauri/src/ipc/commands/cli/profile.rs' },
  { store: 'automations_store', face: 'apps/desktop/src-tauri/src/ipc/commands/automation.rs' },
] as const

/** 每个偏好库只有一个持有者：组合根开它，它自己的命令面读写，别人不碰。 */
export async function preferencesHaveOneOwner(root: string): Promise<Violation[]> {
  const files = await rust(root)
  const violations: Violation[] = []

  for (const { store, face } of STORE_FACES) {
    const allowed = [PATHS, COMPOSITION_ROOT, face]

    for (const file of await holding(root, files, `${store}(`)) {
      if (!allowed.includes(file)) {
        violations.push({
          policy: 'client-preferences-single-pipeline',
          where: file,
          detail: `${store} 不归这里：组合根开库，${face} 读写`,
        })
      }
    }
  }

  return violations
}

/** 原生业务事件由 Rust surface 生成；应用代码只消费生成监听器。 */
export async function nativeEventsUseGeneratedSurface(root: string): Promise<Violation[]> {
  const surfacePath = 'apps/desktop/src-tauri/src/ipc/mod.rs'
  const generated = 'packages/contract/src/generated/ipc-bindings.ts'
  const surface = await readFile(path.join(root, surfacePath), 'utf8')
  const generatedSource = await readFile(path.join(root, generated), 'utf8')
  const block = surface.match(/\.events\(tauri_specta::collect_events!\[([\s\S]*?)\]\)/)?.[1]
  const violations: Violation[] = []

  if (block === undefined) {
    violations.push({
      policy: 'native-events-use-generated-surface',
      where: surfacePath,
      detail: '没有唯一可读的 collect_events! 清单',
    })
  } else {
    const events = [...block.matchAll(/(?:^|[,\s])([A-Z][A-Za-z0-9_]*)/g)].map((match) => match[1])
    if (events.length === 0) {
      violations.push({
        policy: 'native-events-use-generated-surface',
        where: surfacePath,
        detail: 'collect_events! 为空',
      })
    }
    for (const event of events) {
      if (!generatedSource.includes(`export type ${event} =`)) {
        violations.push({
          policy: 'native-events-use-generated-surface',
          where: generated,
          detail: `${event} 没有生成类型`,
        })
      }
    }
  }

  const files = await walk(
    root,
    ['apps', 'packages'],
    ['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'],
  )
  for (const file of await holding(root, files, '@tauri-apps/api/event')) {
    if (file === generated) {
      continue
    }

    violations.push({
      policy: 'native-events-use-generated-surface',
      where: file,
      detail: '绕过了 Rust 生成的事件契约',
    })
  }

  return violations
}
/** 能力在组合根接线，别处不许自己往 Builder 上挂东西。 */
export async function capabilitiesAreWiredAtTheRoot(root: string): Promise<Violation[]> {
  const owner = 'apps/desktop/src-tauri/src/composition.rs'
  const files = await rust(root)
  const violations: Violation[] = []

  for (const needle of [
    'tauri::Builder::',
    '.invoke_handler(',
    'register_asynchronous_uri_scheme_protocol(',
  ]) {
    for (const file of await holding(root, files, needle)) {
      if (file !== owner) {
        violations.push({
          policy: 'agent-capabilities-wired-at-the-root',
          where: file,
          detail: `${needle} 只允许出现在组合根`,
        })
      }
    }
  }

  return violations
}

/**
 * 设计令牌只有一个定义方；用它的人随便用，定义它的只能有一个。
 *
 * 令牌命名空间是 --ui-（packages/design-system 里 170+ 处定义）。--cp- 不在此列：那是
 * 组件局部派生量的命名空间（判例 ADR 0015 的 --cp-dock-clearance），产品布局
 * 尺寸不进全局令牌（ui-authority-boundaries.md 明文），定义权随组件走。
 */
export async function designSystemOwnsItsTokens(root: string): Promise<Violation[]> {
  const violations: Violation[] = []

  for (const file of await walk(root, ['apps', 'packages'], ['.css'])) {
    if (file.startsWith('packages/design-system/')) {
      continue
    }

    const source = await readFile(path.join(root, file), 'utf8')

    for (const line of source.split('\n')) {
      if (line.trim().startsWith('--ui-')) {
        violations.push({
          policy: 'design-system-token-authority',
          where: file,
          detail: '令牌定义不归这里：定义在 packages/design-system，别处只许 var() 引用',
        })
        break
      }
    }
  }

  return violations
}

/** 窗口标签是一处声明，不许在调用点写字面量。 */
export async function windowSurfaceIsNamedOnce(root: string): Promise<Violation[]> {
  const owner = 'apps/desktop/src-tauri/src/window/state.rs'
  const files = await rust(root)
  const violations: Violation[] = []

  for (const file of await holding(root, files, 'get_webview_window("')) {
    violations.push({
      policy: 'window-surface-policy',
      where: file,
      detail: '窗口标签写成了字面量，应当引用 MAIN_WINDOW',
    })
  }

  const declared = await holding(root, files, 'pub const MAIN_WINDOW')

  if (declared.length !== 1 || declared[0] !== owner) {
    violations.push({
      policy: 'window-surface-policy',
      where: owner,
      detail:
        'MAIN_WINDOW 的声明处必须唯一且落在 window/state（组合根只消费，window 不得反向依赖组合根）',
    })
  }

  return violations
}

/** 通配再导出让一个模块交出去的东西不可枚举。 */
export async function noWildcardReExports(root: string): Promise<Violation[]> {
  const violations: Violation[] = []

  for (const file of await walk(root, ['apps', 'crates'], ['.rs'])) {
    const source = await readFile(path.join(root, file), 'utf8')

    for (const line of source.split('\n')) {
      const trimmed = line.trim()

      if (trimmed.startsWith('pub use ') && trimmed.endsWith('::*;')) {
        violations.push({
          policy: 'wildcard-module-declarations',
          where: file,
          detail: trimmed,
        })
      }
    }
  }

  for (const file of await walk(root, ['apps', 'packages', 'tools'], ['.d.ts'])) {
    /* CSS 副作用导入的类型来源：全仓唯一被认可的模块通配声明（见该文件头）。 */
    if (file === 'packages/design-system/src/css.d.ts') {
      continue
    }

    const source = await readFile(path.join(root, file), 'utf8')

    for (const line of source.split('\n')) {
      if (line.includes('declare module ') && line.includes('*')) {
        violations.push({
          policy: 'wildcard-module-declarations',
          where: file,
          detail: line.trim(),
        })
      }
    }
  }

  return violations
}

const tokens = (source: string): string[] =>
  source
    .split(BACKTICK)
    .join(' ')
    .split(/[\s'"()[\],;:<>|]+/)
    .filter((token) => token.length > 0)

const prose = (root: string): Promise<string[]> => walk(root, ['.'], ['.md'])

const present = async (target: string): Promise<boolean> => {
  try {
    await readFile(target)
    return true
  } catch {
    return false
  }
}

/** 文档点名的脚本必须存在，并且不许还指着已经不在的目录。 */
export async function documentedScriptsExist(root: string): Promise<Violation[]> {
  const violations: Violation[] = []

  for (const file of await prose(root)) {
    const source = await readFile(path.join(root, file), 'utf8')

    for (const token of tokens(source)) {
      if (token.startsWith('scripts/')) {
        violations.push({
          policy: 'documented-scripts-exist',
          where: file,
          detail: `仍指着已删除的 ${token}`,
        })
        continue
      }

      if (!token.startsWith('tools/') || !token.endsWith('.ts')) {
        continue
      }

      if (!(await present(path.join(root, token)))) {
        violations.push({
          policy: 'documented-scripts-exist',
          where: file,
          detail: `点名了不存在的 ${token}`,
        })
      }
    }
  }

  return violations
}

/** 文档点名的包必须是真实工作区。 */
const WORKSPACE_NAME = /^@poietica\/[a-z][a-z0-9-]*$/

export async function documentedPackagesExist(
  root: string,
  workspaces: readonly Workspace[],
): Promise<Violation[]> {
  const known = new Set(workspaces.map((workspace) => workspace.name))
  const violations: Violation[] = []

  for (const file of await prose(root)) {
    const source = await readFile(path.join(root, file), 'utf8')

    for (const token of tokens(source)) {
      /* 只认真实形状的包名；`@poietica/*`、`@poietica/<目录名>` 这类泛指不是点名。 */
      if (!WORKSPACE_NAME.test(token)) {
        continue
      }

      const named = token.split('/').slice(0, 2).join('/')

      if (!known.has(named)) {
        violations.push({
          policy: 'documented-packages-exist',
          where: file,
          detail: `点名了不存在的包 ${named}`,
        })
      }
    }
  }

  return violations
}

/** 包名与它的目录同名：路径就是身份，不许两套叫法。 */
export function workspaceNamesFollowTheirDirectory(workspaces: readonly Workspace[]): Violation[] {
  const violations: Violation[] = []

  for (const workspace of workspaces) {
    if (UNLAYERED_DIRECTORIES.includes(workspace.directory)) {
      continue
    }

    const segment = workspace.directory.split('/').at(-1)

    if (segment === undefined || workspace.name !== `@poietica/${segment}`) {
      violations.push({
        policy: 'workspace-manifest-conventions',
        where: `${workspace.directory}/package.json`,
        detail: `${workspace.name} 与目录不同名`,
      })
    }
  }

  return violations
}

/** 只为一次任务活着的守卫：标记式技术债零容忍。 */
export async function noTaskScopedGuards(root: string): Promise<Violation[]> {
  const marks = ['TO' + 'DO', 'FIX' + 'ME', '@ts-expect-error', 'biome-ignore']
  const violations: Violation[] = []
  const files = await walk(
    root,
    ['apps', 'crates', 'packages', 'tests', 'tools'],
    ['.rs', '.ts', '.tsx', '.css', '.sql'],
  )

  for (const file of files) {
    if (file === SELF) {
      continue
    }

    const source = await readFile(path.join(root, file), 'utf8')

    for (const mark of marks) {
      if (source.includes(mark)) {
        violations.push({
          policy: 'no-task-scoped-guards',
          where: file,
          detail: `留了 ${mark} 形式的技术债`,
        })
      }
    }
  }

  return violations
}

/** 领域必须在 cargo 图上被应用可达：没有调用方的领域就是第二条管线。 */
export function domainCratesAreReachable(crates: readonly Crate[]): Violation[] {
  const edges = new Map(crates.map((crate) => [crate.name, crate.dependencies]))
  const seen = new Set<string>()
  const pending = ['poietica']

  while (pending.length > 0) {
    const current = pending.pop()

    if (current === undefined || seen.has(current)) {
      continue
    }

    seen.add(current)

    for (const next of edges.get(current) ?? []) {
      pending.push(next)
    }
  }

  const required = CARGO_RINGS.filter((ring) => ring.name !== 'composition').flatMap((ring) => [
    ...ring.members,
  ])

  return required
    .filter((name) => !seen.has(name))
    .map((name) => ({
      policy: 'domain-crates-are-reachable',
      where: name,
      detail: '应用 crate 到不了它：能力没有生产调用方',
    }))
}

/** 进程级可变状态必须由组合根构造并持有。 */
export async function processStateIsComposedAtRoot(root: string): Promise<Violation[]> {
  const declarations = [
    ['apps/desktop/src/automation/automation-runtime.tsx', 'export const automationStore ='],
    ['apps/desktop/src/entry/plugin-runtime.tsx', 'export const pluginStore ='],
    ['apps/desktop/src/entry/plugin-runtime.tsx', 'export const hostedMcpServersReady:'],
    ['apps/desktop/src/shell/workspace-layout-store.ts', 'export const workspaceLayoutStore ='],
    ['packages/problem/src/failure-coordinator.ts', 'export const failureCoordinator = new'],
    [
      'packages/native-bridge/src/platform/native-window.ts',
      'const mainWindow = resolveMainWindow()',
    ],
  ] as const
  const violations: Violation[] = []

  for (const [file, declaration] of declarations) {
    if ((await readFile(path.join(root, file), 'utf8')).includes(declaration)) {
      violations.push({
        policy: 'process-state-is-composed-at-root',
        where: file,
        detail: `进程级实例在组合根之外创建：${declaration}`,
      })
    }
  }

  return violations
}

/** 运行帧的生成契约不得退化成 JsonValue，再由 TS 守卫冒充完整联合。 */
export async function runFrameWireStaysTyped(root: string): Promise<Violation[]> {
  const probes = [
    ['apps/desktop/src-tauri/src/ipc/commands/conversation/dto.rs', 'pub events: Vec<Value>'],
    ['apps/desktop/src-tauri/src/ipc/commands/conversation/dto.rs', '#[specta(type = Vec<Value>)]'],
    ['packages/native-bridge/src/gateways/agent.ts', 'events.filter(isRunEvent)'],
  ] as const
  const violations: Violation[] = []

  for (const [file, needle] of probes) {
    if ((await readFile(path.join(root, file), 'utf8')).includes(needle)) {
      violations.push({
        policy: 'run-frame-wire-stays-typed',
        where: file,
        detail: `运行帧边界退化：${needle}`,
      })
    }
  }

  return violations
}

/** Review watcher 必须是有所有者的订阅，不得以超时命令伪装推送。 */
export async function reviewWatcherHasLease(root: string): Promise<Violation[]> {
  const probes = [
    ['apps/desktop/src-tauri/src/ipc/commands/git.rs', 'git_await_change'],
    ['crates/git-adapter/src/watch.rs', 'const WINDOW:'],
    ['packages/review/src/review-gateway.ts', 'awaitChange(root: string)'],
  ] as const
  const violations: Violation[] = []

  for (const [file, needle] of probes) {
    if ((await readFile(path.join(root, file), 'utf8')).includes(needle)) {
      violations.push({
        policy: 'review-watcher-has-lease',
        where: file,
        detail: `仍是问—等—重挂协议：${needle}`,
      })
    }
  }

  return violations
}
