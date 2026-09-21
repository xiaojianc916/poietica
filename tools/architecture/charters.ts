/** 模块宪章判据：每条规则问的都是"这件事归谁管"，判据是标识符与图，不是措辞。 */

import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { valueBindingsOf, walkFiles } from './imports.ts'
import { CARGO_RINGS, UNLAYERED_DIRECTORIES } from './layering.ts'
import { present, type Violation } from './policies.ts'
import type { Crate, Workspace } from './workspace.ts'

/** 方案文档写的是目标形态、工作记忆是过程记录：都不参与"点名的东西必须存在"。 */
const SKIP = new Set([
  '.git',
  '.github',
  '.turbo',
  '.workbuddy',
  'Architecture',
  'coverage',
  'dist',
  'dist-release',
  'dist-types',
  'gen',
  'node_modules',
  'target',
])

/** 这个文件本身列举了禁用标记，不能把自己算成违规。 */
const SELF = 'tools/architecture/charters.ts'

const BACKTICK = String.fromCharCode(96)

/** 本文件那条更宽的跳过清单：方案文档、工作记忆与产物都不参与判据。 */
const walk = (
  root: string,
  from: readonly string[],
  suffixes: readonly string[],
): Promise<string[]> =>
  walkFiles(
    root,
    from,
    (file) => suffixes.some((suffix) => file.endsWith(suffix)),
    (name) => !SKIP.has(name),
  )

const rust = (root: string): Promise<string[]> => walk(root, ['apps', 'crates'], ['.rs'])

/*
 * 一次闸门运行里同一份文件会被多条法则读：按路径缓存，每条法则各读一遍就是
 * O(法则数 × 文件数)，加一条法则就多一整轮磁盘读。进程一次性，缓存不必失效。
 */
const SOURCES = new Map<string, string>()

async function readOnce(root: string, file: string): Promise<string> {
  const absolute = path.join(root, file)
  const held = SOURCES.get(absolute)

  if (held !== undefined) {
    return held
  }

  const source = await readFile(absolute, 'utf8')
  SOURCES.set(absolute, source)

  return source
}

async function holding(root: string, files: readonly string[], needle: string): Promise<string[]> {
  const hits: string[] = []

  for (const file of files) {
    if ((await readOnce(root, file)).includes(needle)) {
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
  { store: 'settings_store', face: 'apps/desktop/src-tauri/src/settings/storage.rs' },
  { store: 'agents_store', face: 'apps/desktop/src-tauri/src/agent/profile.rs' },
  { store: 'automations_store', face: 'apps/desktop/src-tauri/src/automation/host.rs' },
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

    const source = await readOnce(root, file)

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

/** 从主题运行时源码读出某一 scheme 的预运行原生表面色。 */
function surfaceColor(
  source: string,
  scheme: 'light' | 'dark',
): readonly [number, number, number] | null {
  const line = source.split('\n').find((candidate) => candidate.includes([scheme, ': ['].join('')))
  const values = line?.match(/[0-9]+/g)?.map(Number)
  const red = values?.[0]
  const green = values?.[1]
  const blue = values?.[2]

  if (
    red === undefined ||
    green === undefined ||
    blue === undefined ||
    values?.[3] !== undefined ||
    ![red, green, blue].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  ) {
    return null
  }

  return [red, green, blue]
}

/** 从宿主衬底源码读 `const X_SURFACE: Color(r, g, b, a)` 那一格。 */
function hostSurfaceColor(
  source: string,
  name: 'LIGHT' | 'DARK',
): readonly [number, number, number] | null {
  const declaration = new RegExp(
    ['const ', name, '_SURFACE: Color = Color\\(([0-9]+), ([0-9]+), ([0-9]+), '].join(''),
  ).exec(source)
  const channels = declaration?.slice(1, 4).map(Number)

  if (
    channels === undefined ||
    channels.length !== 3 ||
    !channels.every((value) => Number.isInteger(value) && value >= 0 && value <= 255)
  ) {
    return null
  }

  return channels as [number, number, number]
}

const toHex = (color: readonly [number, number, number]): string =>
  ['#', color.map((value) => value.toString(16).padStart(2, '0')).join('')].join('')

/** 从调色板源码读某一格的字面值。写 oklch 之类的派生表达式就核不动了，判 null。 */
function paletteColor(source: string, token: string): readonly [number, number, number] | null {
  const hex = new RegExp(['^\\s*', token, ':\\s*#([0-9a-f]{6});'].join(''), 'm').exec(source)?.[1]

  if (hex === undefined) {
    return null
  }

  return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ]
}

/** 衬底正本：设计系统里那两格外壳色，窗口衬底与外壳同色是这条策略的要点。 */
const SURFACE_ORIGIN = 'packages/design-system/src/tokens/palette.css'

type Rgb = readonly [number, number, number]

/** 外壳档必须指向衬底正本；分叉时拖拽露出的那一层与顶部栏、侧栏对不上。 */
async function chromePointsAtOrigin(root: string): Promise<Violation[]> {
  const violations: Violation[] = []

  for (const [cssFile, token] of [
    ['packages/design-system/src/tokens/light.css', '--ui-palette-neutral-75'],
    ['packages/design-system/src/tokens/dark.css', '--ui-palette-dark-850'],
  ] as const) {
    const declaration = ['--ui-chrome: var(', token, ');'].join('')

    if (!(await readFile(path.join(root, cssFile), 'utf8')).includes(declaration)) {
      violations.push({
        policy: 'window-surface-policy',
        where: cssFile,
        detail: ['--ui-chrome 必须指向衬底正本 ', token].join(''),
      })
    }
  }

  return violations
}

/** 三份抄本各自与正本逐字相等：渲染层的 RGB 投影、预运行初稿、窗口创建底色。 */
async function copiesMatchOrigin(
  root: string,
  origin: Readonly<Record<'light' | 'dark', Rgb>>,
  projected: Readonly<Record<'light' | 'dark', Rgb>>,
): Promise<Violation[]> {
  const violations: Violation[] = []
  const themeOwner = 'apps/desktop/src/window/theme-runtime.ts'
  const indexPath = 'apps/desktop/index.html'
  const indexSource = await readFile(path.join(root, indexPath), 'utf8')

  for (const scheme of ['light', 'dark'] as const) {
    if (toHex(projected[scheme]) !== toHex(origin[scheme])) {
      violations.push({
        policy: 'window-surface-policy',
        where: themeOwner,
        detail: [scheme, ' 的原生表面投影与调色板正本不一致'].join(''),
      })
    }

    const declaration = ['--window-backing-surface: ', toHex(origin[scheme]), ';'].join('')

    if (!indexSource.includes(declaration)) {
      violations.push({
        policy: 'window-surface-policy',
        where: indexPath,
        detail: [scheme, ' 的预运行表面与调色板衬底正本不一致'].join(''),
      })
    }
  }

  const configPath = 'apps/desktop/src-tauri/tauri.conf.json'
  const config = JSON.parse(await readFile(path.join(root, configPath), 'utf8')) as {
    app?: { windows?: Array<{ label?: string; backgroundColor?: string }> }
  }
  const configured = config.app?.windows?.find((window) => window.label === 'main')?.backgroundColor

  if (configured?.toLowerCase() !== toHex(origin.light)) {
    violations.push({
      policy: 'window-surface-policy',
      where: configPath,
      detail: '主窗口创建底色必须等于调色板的浅色衬底正本',
    })
  }

  const meta = ['<meta content="', toHex(origin.light), '" name="theme-color" />'].join('')

  if (!indexSource.includes(meta)) {
    violations.push({
      policy: 'window-surface-policy',
      where: indexPath,
      detail: 'theme-color 的静态初值必须等于调色板的浅色衬底正本',
    })
  }

  return violations
}

/*
 * 启动衬底必须由宿主按持久化偏好落定，且必须与原生主题一起钉。
 *
 * 只留渲染层投影这一条路时，投影要等设置加载与 React 首帧，中间露出的是
 * tauri.conf.json 的创建值 —— 深色偏好配浅色创建值，启动那一瞬就是浅色底。
 * 主题不钉则文档层的预运行初稿继续跟系统走，与偏好脱钩，页面自己刷成浅色。
 */
async function startupSurfaceIsAdopted(
  root: string,
  origin: Readonly<Record<'light' | 'dark', Rgb>>,
  surfaceSource: string,
): Promise<Violation[]> {
  const violations: Violation[] = []
  const owner = 'apps/desktop/src-tauri/src/window/surface.rs'

  /* 宿主启动落定用的那两格是第四份抄本，同样与正本逐通道相等。 */
  for (const [name, expected] of [
    ['LIGHT', origin.light],
    ['DARK', origin.dark],
  ] as const) {
    const copied = hostSurfaceColor(surfaceSource, name)

    if (copied === null || toHex(copied) !== toHex(expected)) {
      violations.push({
        policy: 'window-surface-policy',
        where: owner,
        detail: [name, '_SURFACE 必须等于调色板衬底正本'].join(''),
      })
    }
  }

  for (const [file, needle, detail] of [
    [owner, 'pub fn adopt(', '启动衬底必须由宿主按偏好落定'],
    [owner, 'window.set_theme(', '启动落定必须同时钉住原生主题，否则文档层跟着系统走'],
    [
      'apps/desktop/src-tauri/src/composition.rs',
      '.adopt(&main_window,',
      '组合根必须在窗口被看见之前落定衬底',
    ],
  ] as const) {
    if (!(await readOnce(root, file)).includes(needle)) {
      violations.push({ policy: 'window-surface-policy', where: file, detail })
    }
  }

  return violations
}

/** 主题表面与预运行底色、权限、唯一写入管线一致。 */
async function themeSurfaceIsAligned(root: string): Promise<Violation[]> {
  const violations: Violation[] = []
  const themeOwner = 'apps/desktop/src/window/theme-runtime.ts'

  const originSource = await readFile(path.join(root, SURFACE_ORIGIN), 'utf8')
  const light = paletteColor(originSource, '--ui-palette-neutral-75')
  const dark = paletteColor(originSource, '--ui-palette-dark-850')

  if (light === null || dark === null) {
    return [
      {
        policy: 'window-surface-policy',
        where: SURFACE_ORIGIN,
        detail: '衬底正本必须是可核对的字面十六进制：--ui-palette-neutral-75 与 dark-850',
      },
    ]
  }

  const themeSource = await readFile(path.join(root, themeOwner), 'utf8')
  const projectedLight = surfaceColor(themeSource, 'light')
  const projectedDark = surfaceColor(themeSource, 'dark')

  if (projectedLight === null || projectedDark === null) {
    return [
      {
        policy: 'window-surface-policy',
        where: themeOwner,
        detail: '主题运行时必须声明可静态核对的 light/dark 原生表面色',
      },
    ]
  }

  violations.push(...(await chromePointsAtOrigin(root)))
  violations.push(
    ...(await copiesMatchOrigin(
      root,
      { light, dark },
      { light: projectedLight, dark: projectedDark },
    )),
  )

  const hostSurfaceProbes = [
    ['apps/desktop/src-tauri/src/window/surface.rs', 'pub struct WindowSurface'],
    ['apps/desktop/src-tauri/src/window/lifecycle.rs', 'state::<WindowSurface>().reapply(window)'],
    ['apps/desktop/src-tauri/src/ipc/mod.rs', 'window::commands::window_set_surface'],
    ['packages/native-bridge/src/window.ts', 'commands.windowSetSurface'],
  ] as const
  for (const [file, needle] of hostSurfaceProbes) {
    if (!(await readOnce(root, file)).includes(needle)) {
      violations.push({
        policy: 'window-surface-policy',
        where: file,
        detail: '窗口底色必须由宿主状态持有，并在恢复前重应用',
      })
    }
  }

  /*
   * 衬底是两层独立表面：原生窗口一层、WebView2 一层。创建期
   * （WebviewWindowBuilder::background_color）两层一起设，运行期只设窗口层就会
   * 留下一层停在创建值 —— 深色下拖拽与启动露出的正是那一层。
   */
  const surfaceSource = await readFile(path.join(root, hostSurfaceProbes[0][0]), 'utf8')
  for (const [needle, detail] of [
    ['window.set_background_color(', '衬底必须设原生窗口层'],
    [
      'get_webview(MAIN_WINDOW)',
      '衬底必须设主 WebView2 层：按 label 直取，不走 get_webview_window',
    ],
  ] as const) {
    if (!surfaceSource.includes(needle)) {
      violations.push({ policy: 'window-surface-policy', where: hostSurfaceProbes[0][0], detail })
    }
  }

  violations.push(...(await startupSurfaceIsAdopted(root, { light, dark }, surfaceSource)))

  const typeScriptFiles = await walk(root, ['apps', 'packages'], ['.ts', '.tsx'])
  for (const file of await holding(root, typeScriptFiles, '.setBackgroundColor(')) {
    violations.push({
      policy: 'window-surface-policy',
      where: file,
      detail: '渲染层绕过了宿主窗口底色命令',
    })
  }
  const themeWriters = await holding(root, typeScriptFiles, 'applyThemePreference(')
  const allowedThemeWriters = new Set([
    themeOwner,
    'packages/design-system/src/theme/theme-controller.ts',
  ])
  for (const file of themeWriters) {
    if (!allowedThemeWriters.has(file)) {
      violations.push({
        policy: 'window-surface-policy',
        where: file,
        detail: '主题写入必须经过应用主题运行时',
      })
    }
  }
  for (const file of allowedThemeWriters) {
    if (!themeWriters.includes(file)) {
      violations.push({
        policy: 'window-surface-policy',
        where: file,
        detail: '主题唯一写入管线不完整',
      })
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

  violations.push(...(await themeSurfaceIsAligned(root)))

  return violations
}

/** 通配再导出让一个模块交出去的东西不可枚举。 */
export async function noWildcardReExports(root: string): Promise<Violation[]> {
  const violations: Violation[] = []

  for (const file of await walk(root, ['apps', 'crates'], ['.rs'])) {
    const source = await readOnce(root, file)

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

  violations.push(...(await wildcardTypeScriptReExports(root)))
  violations.push(...(await wildcardModuleDeclarations(root)))

  return violations
}

/* 同一判据在 TS 侧：`export * from` 让出口不可枚举，还会把「同名两份定义」静默吞掉
 * —— 那个名字从公开面消失，谁都不会收到任何提示。 */
async function wildcardTypeScriptReExports(root: string): Promise<Violation[]> {
  const violations: Violation[] = []

  for (const file of await walk(root, ['apps', 'packages', 'tools'], ['.ts', '.tsx'])) {
    const source = await readOnce(root, file)

    for (const line of source.split('\n')) {
      if (/^export\s+\*\s+from\s/.test(line.trim())) {
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

async function wildcardModuleDeclarations(root: string): Promise<Violation[]> {
  const violations: Violation[] = []

  for (const file of await walk(root, ['apps', 'packages', 'tools'], ['.d.ts'])) {
    /* CSS 副作用导入的类型来源：全仓唯一被认可的模块通配声明（见该文件头）。 */
    if (file === 'packages/design-system/src/css.d.ts') {
      continue
    }

    const source = await readOnce(root, file)

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

// ADRs record historical decisions rather than the current dependency manifest.
const prose = async (root: string): Promise<string[]> =>
  (await walk(root, ['.'], ['.md'])).filter((file) => !file.startsWith('docs/adr/'))

/** 文档点名的脚本必须存在，并且不许还指着已经不在的目录。 */
export async function documentedScriptsExist(root: string): Promise<Violation[]> {
  const violations: Violation[] = []

  for (const file of await prose(root)) {
    const source = await readOnce(root, file)

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
    const source = await readOnce(root, file)

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
  /* TODO/FIXME 按词匹配：作标识符子串（如 CONVERSATION_TODO_LAYOUT_STYLE）不是债务。 */
  const WORD_MARKS: ReadonlyArray<{ label: string; re: RegExp }> = [
    { label: 'TO' + 'DO', re: new RegExp('\\b' + 'TO' + 'DO' + '\\b') },
    { label: 'FIX' + 'ME', re: new RegExp('\\b' + 'FIX' + 'ME' + '\\b') },
  ]
  /* 压制指令是精确串，无标识符歧义，保留全串匹配。 */
  const LITERAL_MARKS = ['@ts-expect-error', 'biome-ignore']
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

    const source = await readOnce(root, file)

    for (const { label, re } of WORD_MARKS) {
      if (re.test(source)) {
        violations.push({
          policy: 'no-task-scoped-guards',
          where: file,
          detail: `留了 ${label} 形式的技术债`,
        })
      }
    }

    for (const mark of LITERAL_MARKS) {
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

/** JSX modules consume application owners through types and injected values. */
export async function processStateIsComposedAtRoot(root: string): Promise<Violation[]> {
  const owners = new Map<string, ReadonlySet<string>>([
    [
      '@poietica/conversation',
      new Set([
        'TranscriptStore',
        'ThreadsStore',
        'SessionControlsStore',
        'AgentCapabilityStore',
        'ComposerDrafts',
      ]),
    ],
    ['@poietica/update', new Set(['AppUpdateStore'])],
    ['@poietica/automation', new Set(['createAutomationStore'])],
    ['@poietica/extension', new Set(['createPluginStore'])],
    ['@poietica/settings', new Set(['PersonalizationStore'])],
    ['@poietica/workspace/panels', new Set(['createAuxiliaryPanelStore'])],
  ])
  const violations: Violation[] = []
  const files = await walk(root, ['apps', 'packages'], ['.tsx'])
  for (const file of files) {
    if (file.includes('/__tests__/') || file.endsWith('.test.tsx') || file.endsWith('.spec.tsx')) {
      continue
    }
    for (const binding of valueBindingsOf(file, await readOnce(root, file))) {
      const declared = owners.get(binding.specifier)
      if (declared !== undefined && (binding.name === '*' || declared.has(binding.name))) {
        violations.push({
          policy: 'process-state-is-composed-at-root',
          where: file,
          detail: `JSX must receive application stores from the composition root: ${binding.name}`,
        })
      }
    }
  }
  return violations
}

/** 运行帧不回到生成事件面：屏幕经过走官方 transcript 通道（JSON 透传 + vendored schema）。 */
export async function runFrameWireStaysTyped(root: string): Promise<Violation[]> {
  const probes = [
    ['apps/desktop/src-tauri/src/conversation/dto.rs', 'pub events: Vec<Value>'],
    ['apps/desktop/src-tauri/src/conversation/dto.rs', '#[specta(type = Vec<Value>)]'],
    ['packages/native-bridge/src/conversation/session.ts', 'events.filter(isRunEvent)'],
    ['packages/native-bridge/src/conversation/session.ts', 'agentRunBatch'],
    ['packages/native-bridge/src/conversation/session.ts', 'AgentFramePage'],
  ] as const
  const violations: Violation[] = []

  for (const [file, needle] of probes) {
    if ((await readOnce(root, file)).includes(needle)) {
      violations.push({
        policy: 'run-frame-wire-stays-typed',
        where: file,
        detail: `帧边界退化或旧帧面回流：${needle}`,
      })
    }
  }

  return violations
}

/** 契约包的转发层只许转发。
 *
 * 领域包经这些子路径拿到自己那一片线上类型，而不是整张生成面 —— 那是
 * transport-contract-is-adapter-private 的执行机构，所以文件本身必须保持透明：
 * 一旦能在这里声明新形状或引入运行时值，跨进程契约就有了第二个产地。
 */
export async function contractShimsStayGenerated(root: string): Promise<Violation[]> {
  const directory = 'packages/contract/src'
  const violations: Violation[] = []
  const forbidden = /^export\s+(interface|const|function|class|enum|let|var)\b/

  for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) {
      continue
    }

    const file = `${directory}/${entry.name}`
    const source = await readOnce(root, file)

    for (const line of source.split('\n')) {
      const trimmed = line.trim()

      if (forbidden.test(trimmed)) {
        violations.push({
          policy: 'contract-shims-stay-generated',
          where: file,
          detail: `转发层声明了新形状：${trimmed}`,
        })
        continue
      }

      /* 值导入会把这层变成可执行代码；契约包只转发类型。 */
      if (/^import\s+\{/.test(trimmed)) {
        violations.push({
          policy: 'contract-shims-stay-generated',
          where: file,
          detail: `转发层引入了运行时值：${trimmed}`,
        })
      }
    }
  }

  return violations
}

/** Review watcher 必须是有所有者的订阅，不得以超时命令伪装推送。 */
export async function reviewWatcherHasLease(root: string): Promise<Violation[]> {
  const probes = [
    ['apps/desktop/src-tauri/src/review.rs', 'git_await_change'],
    ['crates/git-adapter/src/watch.rs', 'const WINDOW:'],
    ['packages/review/src/review-gateway.ts', 'awaitChange(root: string)'],
  ] as const
  const violations: Violation[] = []

  for (const [file, needle] of probes) {
    if ((await readOnce(root, file)).includes(needle)) {
      violations.push({
        policy: 'review-watcher-has-lease',
        where: file,
        detail: `仍是问—等—重挂协议：${needle}`,
      })
    }
  }

  return violations
}
