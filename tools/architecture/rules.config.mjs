/**
 * Architecture rules — data, not programs.
 *
 * Every rule is a regular expression evaluated against production source files.
 * Adding a rule means adding an object here; it never means adding a script.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const repositoryRoot = path.resolve(import.meta.dirname, '../..')

/*
 * 扫描根必须是真实存在的顶层目录。
 *
 * 这份配置曾经声明 agent / editor / features / foundations / platforms，
 * 重构后五个目录一个不剩，packages/ 又从未被列进来 —— 十四个包一行没被扫过，
 * Architecture rules passed. 是空转出来的绿。所以不只列名字，还要当场断言。
 */
export const sourceRoots = ['apps', 'packages']

/*
 * sourceRoots 是 pattern 规则的扫描根；inventoryRoots 是 check 规则的。crates 里
 * 没有 .ts，但目录命名与 Cargo.toml 分层都管得到它。上一版给治理段单独抄了一份根
 * 列表和一份忽略名单，两份要人手同步 —— 现在根列表两张、忽略名单一张。
 */
export const inventoryRoots = ['apps', 'crates', 'packages']

for (const root of new Set([...sourceRoots, ...inventoryRoots])) {
  if (!existsSync(path.join(repositoryRoot, root))) {
    throw new Error(
      `architecture: 扫描根声明了不存在的目录 "${root}"。` +
        '目录被移动或删除后，这份配置必须同步更新，否则规则会静默失效。',
    )
  }
}

export const ignoredDirectories = new Set([
  '.git',
  '.refactor-backup',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'generated',
  'node_modules',
  'target',
])

export const sourceExtensions = new Set(['.ts', '.tsx'])

const isProductionSource = (file) =>
  !/\.(?:test|spec)\.[jt]sx?$/.test(file) && !file.includes('/__tests__/')

const inDirectory = (directory) => (file) =>
  isProductionSource(file) && file.startsWith(`${directory}/`)

const escapeForRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const alternation = (values) => values.map(escapeForRegExp).join('|')

/*
 * 依赖方向。
 *
 * 边不在这里声明。各包 package.json 的 dependencies 已经声明过一遍，而 bun 的
 * 隔离式 node_modules 又决定了没写进去的包在源码里根本解析不到 —— 工作区 manifest
 * 就是这个仓库唯一真实存在的依赖图，turbo 的 ^task 读的也是它。在这里再抄一份
 * 「谁可以依赖谁」，抄出来的是第二个真相。
 *
 * 上一版抄了：按包名拼出十五条正则去扫源文件的 import 说明符，允许集是
 * tiers.slice(0, index + 1) —— 含自己那一层。于是同一层里装了几个包，它们彼此
 * 互指就一律零约束；而只装了一个包的那些层，层内无从互指。
 * 这张表覆盖的，正是它管不着的地方。
 *
 * 现在它只回答正则回答不了的那个问题：方向。判据落在 manifest 的边上，违规位置
 * 是 package.json 的那一行，不是散在几十个源文件里的 import。
 */
const layers = [
  { name: 'foundations', packages: ['core', 'ui'] },
  { name: 'protocol', packages: ['agent-contract'] },
  { name: 'domain', packages: ['agent', 'agent-catalog'] },
  { name: 'transport', packages: ['ipc'] },
  {
    name: 'features',
    packages: ['automations', 'agent-ui', 'browser', 'plugins', 'settings', 'workspace'],
  },
  { name: 'composition', packages: ['desktop-adapters'] },
  { name: 'application', packages: ['desktop'] },
]

/*
 * 同层依赖默认禁止。同层的包彼此平级，一旦互指，「层」就退化成一个标签 —— 层内
 * 的方向再没有任何东西约束。仅有的一条列在这里并附理由；对应的 manifest 边一旦
 * 消失，这里的条目就成了过期豁免，规则会反过来把它报出来。
 */
const sameLayerDependencies = [
  { from: 'agent', to: 'agent-catalog', reason: '线程按 agentId 定址，名单与线程状态同层同域' },
]

/* 只有这三个包可以直连原生宿主。判据落在 manifest：没声明的包在 bun 下解析不到。 */
const nativeAllowed = new Set(['desktop', 'desktop-adapters', 'ipc'])

/*
 * 分层表与工作区对账，一次做完。
 *
 * 上一版把这件事拆成三段各自为政地跑：directoryOf 逐包 existsSync、一段循环找
 * 「磁盘上多出来的包」、再一段循环核对包名。表里写了一个磁盘上已经不存在的包时，
 * directoryOf 在第一个受害者身上直接抛 —— 整个检查器死在模块加载期，一次只报一
 * 个名字，改完再跑再报下一个。run.mjs 开头写着 "Never short-circuits."，这份配
 * 置却把那条原则毁在了加载阶段。
 *
 * 现在工作区只扫一次，两个方向与包名核对合并成一份清单，一次抛全。
 */
const layeredPackages = new Map()

for (const root of sourceRoots) {
  for (const entry of readdirSync(path.join(repositoryRoot, root), { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue
    }

    const directory = `${root}/${entry.name}`

    if (existsSync(path.join(repositoryRoot, directory, 'package.json'))) {
      layeredPackages.set(entry.name, directory)
    }
  }
}

const placed = new Map()
const mismatches = []

for (const [index, layer] of layers.entries()) {
  for (const pkg of layer.packages) {
    if (placed.has(pkg)) {
      mismatches.push(`"${pkg}" 被放进了不止一层`)
      continue
    }

    placed.set(pkg, index)

    const directory = layeredPackages.get(pkg)

    if (directory === undefined) {
      mismatches.push(`分层表里的 "${pkg}" 在磁盘上不存在 —— 包删除或改名后必须同步这张表`)
      continue
    }

    /* 允许集按包名拼装，所以包名与目录名必须一致，否则规则会指向错误的东西。 */
    const declared = JSON.parse(
      readFileSync(path.join(repositoryRoot, directory, 'package.json'), 'utf8'),
    ).name

    if (declared !== `@poietica/${pkg}`) {
      mismatches.push(`${directory} 的包名是 "${declared}"，与目录名不一致`)
    }
  }
}

/* 新增一个包却没有给它定层，就在这里失败 —— 而不是安静地不受任何方向约束。 */
for (const [pkg, directory] of layeredPackages) {
  if (!placed.has(pkg)) {
    mismatches.push(`${directory} 没有出现在分层表里 —— 新增包必须先声明它属于哪一层`)
  }
}

/*
 * 分层之外的工作区成员。package.json 把 tests 列为成员，而分层只覆盖
 * sourceRoots，所以上面那条「新增包必须先定层」抓不到它。洞就是洞 —— 显式豁免
 * 比隐式遗漏可信。下面这段保证这份名单与磁盘一致。
 */
const UNLAYERED_PACKAGES = ['tests']

for (const directory of UNLAYERED_PACKAGES) {
  if (!existsSync(path.join(repositoryRoot, directory, 'package.json'))) {
    mismatches.push(`${directory}/package.json 不存在 —— 豁免名单必须与 package.json 一致`)
  }
}

if (mismatches.length > 0) {
  throw new Error(
    ['architecture: 分层表与工作区对不上：', ...mismatches.map((item) => `  · ${item}`)].join('\n'),
  )
}

/*
 * 判据是 import 说明符，不是包名在文本里出现过。后行断言零宽，match.index
 * 仍落在包名上，报出来的列号才继续指着出问题的那个字。
 */
const SPECIFIER = String.raw`(?<=(?:from|import)\s*\(?\s*['"])`

/*
 * 包名指回自己。
 *
 * 方向判据抓不到它（自己永远在自己的允许集里），public-package-exports 管的是
 * src/ 深路径，no-cross-boundary-relative-imports 管的是相对路径跨包 —— 三条围了
 * 一圈，恰好漏掉这一个方向，而绕一圈回到包入口就是模块环：全是 import type 时
 * 运行时不炸，于是没有任何东西会说话。
 *
 * 包入口是给别人看的那道边界。自己人绕它一圈，这道边界就是假的。这条只能落在源
 * 文件上：manifest 看不见一个包怎么引用它自己。
 */
const entryOwnershipRules = [...placed.keys()].map((pkg) => ({
  id: `${pkg}-owns-its-entry`,
  appliesTo: inDirectory(layeredPackages.get(pkg)),
  pattern: new RegExp(`${SPECIFIER}@poietica/${escapeForRegExp(pkg)}(?=['"/])`, 'g'),
  message: `${pkg} 不能用包名引用自己：包内走相对路径，否则包入口与模块互指成环`,
}))

/*
 * Design-system control geometry, motion, elevation and stacking are owned by
 * the --ui-* custom properties. Raw utility classes fork that authority.
 */
const restrictedUtilityClasses = [
  { token: 'h-8', replacement: 'h-[var(--ui-control-height-sm)]' },
  { token: 'h-9', replacement: 'h-[var(--ui-control-height-md)]' },
  { token: 'h-10', replacement: 'h-[var(--ui-control-height-lg)]' },
  { token: 'w-9', replacement: 'w-[var(--ui-control-height-md)]' },
  { token: 'duration-150', replacement: 'duration-[var(--ui-duration-fast)]' },
  { token: 'z-50', replacement: 'z-[var(--ui-z-popover)]' },
  { token: 'shadow-2xl', replacement: 'shadow-[var(--ui-shadow-xl)]' },
]

/* ════════════════════════════════════════════════════════════════════════
 * 治理判据 —— 与上面的 pattern 规则同住一张表、同一个汇报通道
 *
 * 这两条看的都不是「源文件里的正则」：一条看目录名，一条看 Cargo.toml。上一版把
 * 它们写成这份配置的加载期副作用，命中就 throw —— run.mjs
 * 开头写着 "Never short-circuits."，而这份文件上面那段注释刚刚痛斥过「把那条
 * 原则毁在加载阶段」，一屏之下就又犯了一次。加载期 throw 的代价是实的：目录名
 * 一旦踩线，pattern 规则与全部 tier 规则的结果都被掩掉，一次只看得见一个问题。
 *
 * 现在它们是 rules 里的普通行，只是用 check 而不是 pattern。遍历由 run.mjs 做
 * 一次，忽略名单只有 ignoredDirectories 一份，违规汇总只有一处。
 * ════════════════════════════════════════════════════════════════════════ */

/*
 * 三类名字被禁，下面这张表是唯一一份，AGENTS.md 只指向它、不重抄。
 *
 *   application / domain / presentation / ports —— DDD 的层名。上面那张 layers
 *     表已经用包边界承担了分层，包内再套一套就是两套架构叠着。
 *   common / helpers / lib / utils / services / managers / stores / state /
 *     types —— 不声明任何边界，最终什么都往里塞。
 *   components —— 按技术种类切，不回答「这是什么能力」。
 *
 * zed 的 crates 是 acp_thread / agent_ui / project / settings_ui，codex-rs 是
 * core / protocol / thread-store，VS Code 是 base / platform / editor /
 * workbench —— 三家一个 DDD 层名、一个万能桶都没有。
 */
const forbiddenDirectoryNames = new Set([
  'application',
  'common',
  'components',
  'domain',
  'helpers',
  'lib',
  'managers',
  'ports',
  'presentation',
  'services',
  'state',
  'stores',
  'types',
  'utils',
])

const capabilityScopedDirectoryNames = (inventory) =>
  inventory.directories
    .filter((directory) => forbiddenDirectoryNames.has(path.basename(directory)))
    .map((directory) => ({
      file: directory,
      message: '目录名不声明能力边界：DDD 层名与万能桶名在任何层级都不允许，目录名必须是具体能力',
    }))

/*
 * docs/architecture/rust-layers.md 的「规则」一节有四条。这里执行其中三条：
 * 不依赖 tauri、互不依赖、必须写 [lints] workspace = true。第四条「领域实体
 * 定义在 native crate，不在 src-tauri」判不了 —— 那需要语义分析，不是正则或
 * 清单能做的事，所以不假装它被守住了。
 */
const nativeCrates = ['agent-runtime', 'browser', 'git', 'persistence', 'plugin-host']

const nativeCratesStayHostAgnostic = async (inventory) => {
  const present = new Set(inventory.files)
  const defects = []

  for (const crate of nativeCrates) {
    const manifest = `crates/${crate}/Cargo.toml`

    if (!present.has(manifest)) {
      defects.push({ file: manifest, message: 'native crate 清单与磁盘不一致：这个文件不存在' })
      continue
    }

    const source = await inventory.read(manifest)

    /* 精确切出 [lints] 段。宽松匹配会被 [dependencies] 里的
     * serde = { workspace = true } 假通过。 */
    const lints = /\n\[lints\]\r?\n([\s\S]*?)(?=\n\[|$)/.exec(`\n${source}`)

    if (lints === null || !/^\s*workspace\s*=\s*true\s*$/m.test(lints[1])) {
      defects.push({
        file: manifest,
        message: '缺少 [lints] workspace = true：工作区的 unsafe_code 与 non_ascii_idents 不生效',
      })
    }

    if (/^\s*tauri[\w.-]*\s*=/m.test(source)) {
      defects.push({ file: manifest, message: '依赖了 tauri：宿主耦合只允许出现在 src-tauri' })
    }

    for (const edge of source.matchAll(/path\s*=\s*"\.\.\/([\w-]+)"/g)) {
      if (edge[1] !== crate && nativeCrates.includes(edge[1])) {
        defects.push({
          file: manifest,
          message: `依赖了 crates/${edge[1]}：native crate 必须互不依赖`,
        })
      }
    }
  }

  for (const file of inventory.files) {
    if (!file.startsWith('crates/') || !file.endsWith('.rs') || /(?:^|\/)tests\//.test(file)) {
      continue
    }

    const hit = /\btauri(?:_[a-z_]+)?\s*::/.exec(await inventory.read(file))

    if (hit !== null) {
      defects.push({ file, message: `引用了 ${hit[0]}：native crate 不得耦合宿主` })
    }
  }

  return defects
}

/*
 * 工作区 manifest 的公共契约面。
 *
 * 工作区 manifest 此前四套写法并存：main/types 与 exports 并存（Bundler 解析下
 * 前两者永远读不到 —— workspace 与 ui 两个包根本没声明，照样跑得通，这是同一个
 * 仓库里的对照实验）；同一个 .ts 目标一半写裸串一半写条件对象；子路径名一半照
 * src 下的路径、一半照框架名。Biome 的 useSortedKeys 是 off，turbo 不看 manifest
 * 形状，tsc 只看解析结果 —— 这些此前不受任何工具约束。
 *
 * 判据只写这些文件自己能证明的事。曾经这里断言过「check 没有调用方」，那需要穷举
 * 全仓所有调用路径 —— 规则做不到，于是成了硬编码断言，两轮都被证伪（一次是根
 * package.json 的同名聚合脚本，一次是未跟踪的 quality.yml.bak）。
 *
 * tests/package.json 不在 inventoryRoots 里，manifest 那几条够不着它 —— 洞就是洞。
 */
const ORCHESTRATED_TOOLS = ['tsc', 'biome']

const WILDCARD_MODULE = /declare\s+module\s+['"](\*\.[\w.]+)['"]/g

const canonicalSubpath = (target) =>
  `./${target.replace(/^\.\/src\//, '').replace(/(?:\/index)?\.tsx?$/, '')}`

const manifestExportDefects = (file, exportMap) =>
  Object.entries(exportMap).flatMap(([subpath, target]) => {
    if (typeof target !== 'string') {
      return [
        {
          file,
          message: `exports["${subpath}"] 用了条件对象：目标是 .ts，types 与 default 同值`,
        },
      ]
    }

    if (subpath === '.' || !/\.tsx?$/.test(target)) {
      return []
    }

    const expected = canonicalSubpath(target)

    return subpath === expected
      ? []
      : [{ file, message: `exports["${subpath}"] 指向 ${target}，子路径名必须是 ${expected}` }]
  })

/* 两个脚本一字不差 —— 调用方分不清该用哪个，而其中一个注定不会被更新。 */
const manifestScriptDefects = (file, scripts) => {
  const seen = new Map()

  return Object.entries(scripts ?? {}).flatMap(([name, body]) => {
    const twin = seen.get(body)

    if (twin === undefined) {
      seen.set(body, name)

      return []
    }

    return [{ file, message: `脚本 "${name}" 与 "${twin}" 一字不差：同一件事两个名字` }]
  })
}

/*
 * 同一个 script 里用 && 串两次同一个程序 —— 那是 task 编排：前一个红了后一个不跑，
 * 缓存粒度也被绑成一个黑盒。这个仓库有 turbo，编排是它的活。只认同名程序，
 * vite build && tauri build 是真的顺序依赖，不在此列。
 */
const manifestOrchestrationDefects = (file, scripts) =>
  Object.entries(scripts ?? {}).flatMap(([name, body]) => {
    const segments = body.split('&&').map((part) => part.trim())

    if (segments.length < 2) {
      return []
    }

    return ORCHESTRATED_TOOLS.filter((tool) => {
      const invocation = new RegExp(`(?:^|\\s)${tool}(?:\\s|$)`)

      return segments.filter((segment) => invocation.test(segment)).length > 1
    }).map((tool) => ({
      file,
      message: `脚本 "${name}" 用 && 串了两次 ${tool}：编排交给 turbo 的 task 图`,
    }))
  })

/* bunfig.toml 声明了 install.exact，版本只能来自 catalog: 或精确号。 */
const manifestVersionDefects = (file, manifest) =>
  DEPENDENCY_BLOCKS.flatMap((block) =>
    Object.entries(manifest[block] ?? {})
      .filter(([, range]) => /^[\^~]/.test(range))
      .map(([dep, range]) => ({
        file,
        message: `${block}.${dep} 是范围 "${range}"：saveExact 之下只能用 catalog: 或精确号`,
      })),
  )

const workspaceManifestConventions = async (inventory) => {
  const defects = []

  for (const file of inventory.files) {
    if (!/^(?:apps|packages)\/[\w-]+\/package\.json$/.test(file)) {
      continue
    }

    const manifest = JSON.parse(await inventory.read(file))

    if (manifest.exports !== undefined) {
      for (const field of ['main', 'types']) {
        if (manifest[field] !== undefined) {
          defects.push({
            file,
            message: `"${field}" 与 exports 并存：Bundler 解析只读 exports，这一行永远不生效`,
          })
        }
      }

      defects.push(...manifestExportDefects(file, manifest.exports))
    }

    for (const entry of manifest.sideEffects ?? []) {
      if (typeof entry === 'string' && entry.startsWith('*') && !entry.startsWith('**/')) {
        defects.push({
          file,
          message: `sideEffects "${entry}" 的 glob 没有目录前缀：各家 bundler 匹配基准不一致`,
        })
      }
    }

    defects.push(...manifestScriptDefects(file, manifest.scripts))
    defects.push(...manifestOrchestrationDefects(file, manifest.scripts))
    defects.push(...manifestVersionDefects(file, manifest))
  }

  return defects
}

/*
 * 通配符模块声明是全局的：写在哪个包里，效果都是整个编译单元。此前四个包各写一份
 * 对 CSS 的声明，给出三种互相矛盾的定义（简写 any、空模块、导出具名 content），
 * 哪一份生效取决于当前编译到哪个包 —— 这种东西只能有一份。
 *
 * 只看每个 .d.ts 自己写了什么，不需要知道谁 import 了谁。
 */
const wildcardModuleDeclarations = async (inventory) => {
  const owners = new Map()

  for (const file of inventory.files) {
    if (!file.endsWith('.d.ts')) {
      continue
    }

    const source = await inventory.read(file)

    for (const match of source.matchAll(WILDCARD_MODULE)) {
      const pattern = match[1]
      const seen = owners.get(pattern) ?? []

      seen.push(file)
      owners.set(pattern, seen)
    }
  }

  return [...owners.entries()]
    .filter(([, files]) => files.length > 1)
    .flatMap(([pattern, files]) =>
      files.map((file) => ({
        file,
        message: `declare module "${pattern}" 还出现在 ${files.filter((other) => other !== file).join('、')} —— 通配符声明是全局的，只能有一份`,
      })),
    )
}

/* 规则里拼出来的路径要与 run.mjs 的 inventory 同形：一律正斜杠。 */
export const toPosixPath = (value) => value.split(path.sep).join('/')

/*
 * 文档里写的 bun 脚本必须真的存在。
 *
 * README 曾经列过 bun format:check —— 根 package.json 里只有 format，照着敲直接失败。
 * 命令表是最容易腐烂的一类文档：它抄的是别处的可执行事实，而没有任何东西在它腐烂时
 * 喊一声。
 *
 * 判据收缩到单个文件就能证明的形状：只认带冒号的调用。bun 的内置命令没有一个带冒号，
 * 所以带冒号的一定是仓库脚本 —— 不需要穷举 bun 的命令表，那是个会变的开放集合，
 * 此前两次栽在穷举开放集合上。不带冒号的调用漏过去，零误报优先于全覆盖。
 *
 * 根 README 与 AGENTS.md 不在 inventoryRoots 下，这里自己读 —— 不为一条规则改变
 * 所有规则的扫描面。
 */
const DOCUMENTED_SCRIPT = /(?<=\bbun\s(?:run\s)?)[a-z][\w-]*:[\w:-]+/g

const documentationFiles = () => {
  const found = ['AGENTS.md', 'README.md'].filter((file) =>
    existsSync(path.join(repositoryRoot, file)),
  )

  const docsRoot = path.join(repositoryRoot, 'docs')

  if (existsSync(docsRoot)) {
    for (const entry of readdirSync(docsRoot, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) {
        continue
      }

      const absolute = path.join(entry.parentPath, entry.name)

      found.push(toPosixPath(path.relative(repositoryRoot, absolute)))
    }
  }

  return found.sort()
}

const declaredScriptNames = async (inventory) => {
  const names = new Set(
    Object.keys(
      JSON.parse(readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).scripts ?? {},
    ),
  )

  for (const file of inventory.files) {
    if (!/^(?:apps|packages)\/[\w-]+\/package\.json$/.test(file)) {
      continue
    }

    for (const name of Object.keys(JSON.parse(await inventory.read(file)).scripts ?? {})) {
      names.add(name)
    }
  }

  return names
}

const documentedScriptsExist = async (inventory) => {
  const declared = await declaredScriptNames(inventory)
  const defects = []

  for (const file of documentationFiles()) {
    const source = readFileSync(path.join(repositoryRoot, file), 'utf8')

    for (const match of source.matchAll(DOCUMENTED_SCRIPT)) {
      if (!declared.has(match[0])) {
        defects.push({
          file,
          message: `文档写着 bun ${match[0]}，但没有任何 manifest 声明这个脚本`,
        })
      }
    }
  }

  return defects
}
/*
 * manifest 里写的 bun <file> 必须真的存在。
 *
 * documented-scripts-exist 只管「文档 → manifest」这一个方向。反方向没有闸门，
 * 于是根 package.json 的 "release": "node release.mjs" 指着一个磁盘上不存在的
 * 文件一直躺着 —— 照着敲直接失败，而 bun 与 turbo 都不校验脚本入口。
 *
 * 判据只依赖单个文件能证明的形状：脚本正文里的路径，与它在不在磁盘上。
 */
const SCRIPT_ENTRYPOINT = /(?:^|\s)bun\s+([\w./-]+\.(?:mjs|ts))/g

const manifestScriptsResolve = async (inventory) => {
  const defects = []

  const manifests = [
    'package.json',
    ...inventory.files.filter((file) => /^(?:apps|packages)\/[\w-]+\/package\.json$/.test(file)),
  ]

  for (const file of manifests) {
    const source =
      file === 'package.json'
        ? readFileSync(path.join(repositoryRoot, file), 'utf8')
        : await inventory.read(file)

    for (const [name, body] of Object.entries(JSON.parse(source).scripts ?? {})) {
      for (const match of body.matchAll(SCRIPT_ENTRYPOINT)) {
        if (!existsSync(path.join(repositoryRoot, match[1]))) {
          defects.push({ file, message: `脚本 "${name}" 运行 ${match[1]}，但这个文件不存在` })
        }
      }
    }
  }

  return defects
}

/*
 * 一个 manifest 上算数的依赖块，全仓一份 —— 依赖图与版本判据读的是同一张表。
 *
 * dependencies 与 devDependencies 都算 —— bun 与 turbo 都把两者当工作区边，
 * 一条 devDependency 造出来的环同样会卡死 turbo 的 task 图。peerDependencies
 * 同样算：它声明的是宿主必须装上的东西，写成范围就绕开了 saveExact。
 */
const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'peerDependencies']

const LOCAL_PACKAGE = /^@poietica\/([\w-]+)$/

const workspaceDependencyGraph = async (inventory) => {
  const graph = new Map()

  for (const [pkg, directory] of layeredPackages) {
    const manifest = JSON.parse(await inventory.read(`${directory}/package.json`))
    const edges = new Map()

    for (const block of DEPENDENCY_BLOCKS) {
      for (const name of Object.keys(manifest[block] ?? {})) {
        const local = LOCAL_PACKAGE.exec(name)

        if (local !== null && layeredPackages.has(local[1])) {
          edges.set(local[1], `${block}.${name}`)
        }
      }
    }

    graph.set(pkg, edges)
  }

  return graph
}

const layeredWorkspaceDependencies = async (inventory) => {
  const graph = await workspaceDependencyGraph(inventory)
  const defects = []
  const honoured = new Set()

  for (const [pkg, edges] of graph) {
    const from = placed.get(pkg)
    const file = `${layeredPackages.get(pkg)}/package.json`

    for (const [dependency, origin] of edges) {
      const to = placed.get(dependency)

      if (to < from) {
        continue
      }

      if (to > from) {
        defects.push({
          file,
          message: `${origin} 指向更高层：${layers[from].name} 不能依赖 ${layers[to].name}`,
        })
        continue
      }

      const exemption = sameLayerDependencies.find(
        (candidate) => candidate.from === pkg && candidate.to === dependency,
      )

      if (exemption === undefined) {
        defects.push({
          file,
          message: `${origin} 是同层依赖：${layers[from].name} 层内互指要写进 sameLayerDependencies 并给出理由`,
        })
        continue
      }

      honoured.add(exemption)
    }
  }

  for (const exemption of sameLayerDependencies) {
    if (!honoured.has(exemption)) {
      defects.push({
        file: 'tools/architecture/rules.config.mjs',
        message: `同层豁免 ${exemption.from} → ${exemption.to} 已经没有对应的 manifest 边：过期豁免必须删掉`,
      })
    }
  }

  return defects
}

/*
 * 环。turbo 的 ^task 图撞上环会失败，但那要等到有人跑 turbo，而且它报的是任务名。
 * 这里在同一次架构检查里就报出来，报的是哪几个包咬在一起。Kahn 拓扑排序，消不掉
 * 的就是环。
 */
const workspaceGraphIsAcyclic = async (inventory) => {
  const graph = await workspaceDependencyGraph(inventory)
  const pending = new Map([...graph].map(([pkg, edges]) => [pkg, new Set(edges.keys())]))

  let settled = true

  while (settled) {
    settled = false

    for (const [pkg, edges] of [...pending]) {
      if (edges.size > 0) {
        continue
      }

      pending.delete(pkg)

      for (const rest of pending.values()) {
        rest.delete(pkg)
      }

      settled = true
    }
  }

  return [...pending]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([pkg, edges]) => ({
      file: `${layeredPackages.get(pkg)}/package.json`,
      message: `依赖成环：${pkg} 仍指向 ${[...edges].sort().join('、')}，工作区依赖图必须是 DAG`,
    }))
}

/*
 * 死包。
 *
 * 没有任何应用能到达的包是工作区里的死重量：它进不了任何产物，却照样参与
 * typecheck、test 与每一次 install，还会让人以为它是活的。这个仓库真出过一个。
 */
const everyPackageIsReachable = async (inventory) => {
  const graph = await workspaceDependencyGraph(inventory)
  const reachable = new Set()
  const queue = []

  for (const [pkg, directory] of layeredPackages) {
    if (directory.startsWith('apps/')) {
      reachable.add(pkg)
      queue.push(pkg)
    }
  }

  while (queue.length > 0) {
    for (const dependency of graph.get(queue.pop()).keys()) {
      if (!reachable.has(dependency)) {
        reachable.add(dependency)
        queue.push(dependency)
      }
    }
  }

  const defects = []

  for (const [pkg, directory] of layeredPackages) {
    if (!reachable.has(pkg)) {
      defects.push({
        file: `${directory}/package.json`,
        message: '没有任何应用能到达这个包：工作区里的死包当场删掉，不留着等以后',
      })
    }
  }

  return defects
}

/*
 * 原生宿主访问。判据落在 manifest 上：bun 的隔离式 node_modules 决定了没声明的
 * 包 import 不到，「声明了」与「碰得到」在这个仓库里是同一件事。
 */
const nativeHostAccessIsDeclared = async (inventory) => {
  const defects = []

  for (const [pkg, directory] of layeredPackages) {
    if (nativeAllowed.has(pkg)) {
      continue
    }

    const manifest = JSON.parse(await inventory.read(`${directory}/package.json`))

    for (const name of Object.keys(manifest.dependencies ?? {})) {
      if (name.startsWith('@tauri-apps/')) {
        defects.push({
          file: `${directory}/package.json`,
          message: `dependencies.${name}：只有 ${[...nativeAllowed].sort().join('、')} 可以直连原生宿主`,
        })
      }
    }
  }

  return defects
}

/*
 * 工作区成员的包名。
 *
 * layeredPackages 的键是目录名，覆盖面是 sourceRoots —— 它回答的是「分层表管得着
 * 谁」，不是「工作区里有哪些包」。上一版这两件事共用一个名字，第一个消费者当场
 * 掉进去：名字承诺的比它交付的大一圈。名字取自各 manifest 的 name 字段，不由目录
 * 名拼 —— 目录名与包名相等是上面那段单独在守的事，这里不重复预设它成立。
 */
const workspaceMembers = new Set(
  [...layeredPackages.values(), ...UNLAYERED_PACKAGES].map(
    (directory) =>
      JSON.parse(readFileSync(path.join(repositoryRoot, directory, 'package.json'), 'utf8')).name,
  ),
)

/*
 * 文档里写的包必须真的存在。
 *
 * 与 documented-scripts-exist 同一类腐烂：文档抄的是别处的可执行事实，而包改名、
 * 合并、删除时没有任何东西会喊一声。判据只依赖单个文件能证明的形状 —— 文本里出现
 * 的 @poietica/* 字面量，与它在不在工作区里。
 */
const DOCUMENTED_PACKAGE = /@poietica\/[\w-]+/g

const documentedPackagesExist = () => {
  const defects = []

  for (const file of documentationFiles()) {
    const source = readFileSync(path.join(repositoryRoot, file), 'utf8')

    for (const match of source.matchAll(DOCUMENTED_PACKAGE)) {
      if (!workspaceMembers.has(match[0])) {
        defects.push({ file, message: `文档写着 ${match[0]}，但工作区里没有这个包` })
      }
    }
  }

  return defects
}
/*
 * 判据自己的名字必须唯一。
 *
 * 违规按 rule.id 汇报，同名规则会把一次违规记成多笔，而重复的那一条不会让任何
 * 检查失败 —— 它腐烂时没有任何东西会说话。读的是 rules 自己：run.mjs 调用 check
 * 时模块已经求值完毕，引用是安全的。
 */
const ruleIdentifiersAreUnique = () => {
  const counts = new Map()

  for (const rule of rules) {
    counts.set(rule.id, (counts.get(rule.id) ?? 0) + 1)
  }

  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([id, count]) => ({
      file: 'tools/architecture/rules.config.mjs',
      message: `规则 "${id}" 注册了 ${count} 次：违规按 id 汇报，同名会把一次违规记成多笔`,
    }))
}

const WINDOW_SURFACE_FILES = {
  application: 'apps/desktop/src/app.css',
  bootstrap: 'apps/desktop/index.html',
  config: 'apps/desktop/src-tauri/tauri.conf.json',
}

const WRY_DEFAULT_DISABLED_FEATURES = ['msWebOOUI', 'msPdfOOUI', 'msSmartScreenProtection']

const featureSwitch = (browserArguments, name) => {
  const prefix = `--${name}=`
  const value = browserArguments.split(/\s+/).find((part) => part.startsWith(prefix))

  return new Set(value?.slice(prefix.length).split(',').filter(Boolean) ?? [])
}

/* additionalBrowserArgs 是整体替换，不是追加：产品开关必须连同 wry 的默认值一起声明。 */
const browserArgumentDefects = (browserArguments) => {
  const file = WINDOW_SURFACE_FILES.config
  const defects = []
  const disabled = featureSwitch(browserArguments, 'disable-features')
  const enabled = featureSwitch(browserArguments, 'enable-features')

  for (const feature of WRY_DEFAULT_DISABLED_FEATURES) {
    if (!disabled.has(feature)) {
      defects.push({
        file,
        message: `additionalBrowserArgs 覆盖了 Wry 默认值，必须显式保留 ${feature}`,
      })
    }
  }

  if (!disabled.has('RemoveRedirectionBitmap') || enabled.has('RemoveRedirectionBitmap')) {
    defects.push({
      file,
      message: '必须保留 DWM redirection surface：禁用 RemoveRedirectionBitmap',
    })
  }

  if (disabled.has('CalculateNativeWinOcclusion') || enabled.has('CalculateNativeWinOcclusion')) {
    defects.push({
      file,
      message: 'CalculateNativeWinOcclusion 必须交给 WebView2 运行时默认策略',
    })
  }

  if (!enabled.has('msWebView2EnableDraggableRegions')) {
    defects.push({
      file,
      message: '自绘标题栏需要 msWebView2EnableDraggableRegions',
    })
  }

  for (const feature of enabled) {
    if (disabled.has(feature)) {
      defects.push({
        file,
        message: `${feature} 同时出现在 enable-features 与 disable-features`,
      })
    }
  }

  return defects
}

/* Window and WebView surfaces are one platform contract, owned by the Tauri configuration. */
const windowSurfacePolicy = async (inventory) => {
  const defects = []

  for (const file of Object.values(WINDOW_SURFACE_FILES)) {
    if (!inventory.files.includes(file)) {
      defects.push({ file, message: '窗口表面契约指向的文件不存在' })
    }
  }

  if (defects.length > 0) {
    return defects
  }

  const config = JSON.parse(await inventory.read(WINDOW_SURFACE_FILES.config))
  const main = config.app?.windows?.find((window) => window.label === 'main')

  if (main === undefined) {
    return [{ file: WINDOW_SURFACE_FILES.config, message: '没有声明 main 窗口' }]
  }

  if (main.transparent !== false) {
    defects.push({
      file: WINDOW_SURFACE_FILES.config,
      message: 'main 窗口必须是不透明表面',
    })
  }

  if (main.backgroundColor !== '#f3f3f3') {
    defects.push({
      file: WINDOW_SURFACE_FILES.config,
      message: 'main 窗口衬底必须与启动表面的 #f3f3f3 一致',
    })
  }

  const bootstrap = await inventory.read(WINDOW_SURFACE_FILES.bootstrap)
  const application = await inventory.read(WINDOW_SURFACE_FILES.application)
  const rootSurface =
    /html,\s*body,\s*#root\s*\{[^}]*background:\s*var\(--window-backing-surface\);/s

  if (!bootstrap.includes('--window-backing-surface: #f3f3f3;') || !rootSurface.test(bootstrap)) {
    defects.push({
      file: WINDOW_SURFACE_FILES.bootstrap,
      message: '预 React 表面必须以 #f3f3f3 填满 html、body 与 #root',
    })
  }

  if (
    !application.includes('--window-backing-surface: var(--color-chrome);') ||
    !rootSurface.test(application)
  ) {
    defects.push({
      file: WINDOW_SURFACE_FILES.application,
      message: '应用根必须以 --window-backing-surface 填满 html、body 与 #root',
    })
  }

  const browserArguments = main.additionalBrowserArgs

  if (typeof browserArguments !== 'string') {
    defects.push({
      file: WINDOW_SURFACE_FILES.config,
      message: 'main 窗口缺少 WebView2 browser arguments',
    })

    return defects
  }

  defects.push(...browserArgumentDefects(browserArguments))

  return defects
}

const governanceRules = [
  { id: 'rule-identifiers-are-unique', check: ruleIdentifiersAreUnique },
  { id: 'manifest-scripts-resolve', check: manifestScriptsResolve },
  { id: 'capability-scoped-directory-names', check: capabilityScopedDirectoryNames },
  { id: 'layered-workspace-dependencies', check: layeredWorkspaceDependencies },
  { id: 'workspace-graph-is-acyclic', check: workspaceGraphIsAcyclic },
  { id: 'every-package-is-reachable', check: everyPackageIsReachable },
  { id: 'native-host-access-is-declared', check: nativeHostAccessIsDeclared },
  { id: 'native-crates-stay-host-agnostic', check: nativeCratesStayHostAgnostic },
  { id: 'window-surface-policy', check: windowSurfacePolicy },
  { id: 'workspace-manifest-conventions', check: workspaceManifestConventions },
  { id: 'wildcard-module-declarations', check: wildcardModuleDeclarations },
  { id: 'documented-scripts-exist', check: documentedScriptsExist },
  { id: 'documented-packages-exist', check: documentedPackagesExist },
]

/* 唯一允许触碰 Web Storage 的文件。规则与实现必须指着同一条路径。 */
const PREFERENCE_PIPELINE = 'packages/core/src/preference.ts'

/*
 * 一个进程一份的那些事实，都在组合根接一次线。
 *
 * 「现在用哪一家 agent」与「这一家提供哪些可调项」出自同一个文件，也在同一处接
 * 上，所以这里是一对常量而不是两对：下面两条规则守的是同一条纪律。
 */
const AGENT_IDENTITY = 'apps/desktop/src/assistant/agent-runtime.ts'
const COMPOSITION_ROOT = 'apps/desktop/src/shell/app-shell.tsx'

/*
 * domain 层不认识 React。
 *
 * 这一层是投影、状态与不变式：它必须能在 Node 里直接单测，也必须能在渲染器之外被
 * 构造。判据不能只靠 manifest —— 依赖表里没有 react 时 bun 的隔离式 node_modules
 * 确实解析不到，但那张表随时可以被加上一行，而方向判据只认 @poietica/* 的边（见
 * LOCAL_PACKAGE），react 不在其中：hooks 与 Context 搬进 domain 时整条规则一声不响。
 *
 * 范围取自分层表本身，不另抄一份包名 —— domain 是哪几个包只有一个答案。测试文件
 * 一并算数：这是整棵子树的事。zed 的 crates/agent 里没有 gpui，gpui 在
 * crates/agent_ui；VS Code 同样把框架依赖算进方向判据（vs/base/common 不得 import
 * vs/base/browser）。
 */
const FRAMEWORK_FREE_ROOTS = layers
  .find((layer) => layer.name === 'domain')
  .packages.map((pkg) => `${layeredPackages.get(pkg)}/src/`)

export const rules = [
  {
    id: 'public-package-exports',
    appliesTo: isProductionSource,
    pattern: /from\s+['"]@poietica\/[^'"]+\/src\//g,
    message: 'cross-package imports must use public package exports, not src/ deep paths',
  },
  {
    id: 'no-cross-boundary-relative-imports',
    appliesTo: isProductionSource,
    pattern: /from\s+['"](?:\.\.\/){2,}(?:apps|packages)\//g,
    message: 'relative imports must not cross top-level package boundaries',
  },
  /*
   * 客户端偏好只有一条管线。
   *
   * 这条规则存在的理由是它曾经不存在：侧栏布局、工作区折叠、当前工作目录三处
   * 各写一份「读键、编解码、try/catch、storage 事件重读、写盘容错」，三种错误
   * 策略（两处静默吞掉、一处 warn）、两种跨窗口语义（布局那份根本不听 storage
   * 事件，于是另一个窗口改了宽度这边永远不知道）。样板抄第三遍时抄错一个分支，
   * 没有任何工具会说话。
   *
   * 判据落在原始文本上，注释也算：一条指着 Web Storage 的注释要么是在教人再抄
   * 一遍，要么已经腐烂 —— 两种都不该留在生产源码里。
   */
  {
    id: 'client-preferences-single-pipeline',
    appliesTo: (file) => isProductionSource(file) && file !== PREFERENCE_PIPELINE,
    pattern: /\blocalStorage\b/g,
    message: '客户端偏好只有一条管线：用 @poietica/core 的 createPreference',
  },
  /*
   * 「现在用哪一家 agent」只订阅一次。
   *
   * 这个答案住在 agents.json 的 defaultAgentId 上，组合根启动时认一次、设置页
   * 改完再认一次。此前接线层在渲染器闭包里直接调 currentAgentId()，于是那张表
   * 什么时候该重建没有任何东西负责 —— 它能对，靠的是订阅它的组件恰好在上游、
   * 而中间那一层恰好没有被 memo 住。给中间那层加一次记忆化就会静默失效，而
   * 失效的表现是「设置里换了 agent，会话还是上一家」，不报错。
   *
   * 判据落在原始文本上，注释也算：一条教人再去问一次的注释，与真去问一次同样
   * 会让下一个人照做。
   */
  {
    id: 'agent-identity-single-subscription',
    appliesTo: (file) =>
      isProductionSource(file) && file !== AGENT_IDENTITY && file !== COMPOSITION_ROOT,
    pattern: /\bcurrentAgentId\b/g,
    message: 'agent 身份只在组合根订阅一次，其余顺 props 接下去',
  },
  /*
   * 能力表只在组合根造出来。
   *
   * 端口按「用哪一家 agent」建，重问的通知也按同一家来，两件事同源同寿，所以它们
   * 是同一个 effect 的一次装载与一次清理。判据落在构造上，不落在某个函数名上：
   * 「一个进程一份」这条纪律唯一可验证的形状，就是全仓只有组合根出现一次 new。
   *
   * 测试文件不在此列（isProductionSource）—— 它们本来就该各造一份自己的。
   */
  {
    id: 'agent-capabilities-wired-at-the-root',
    appliesTo: (file) => isProductionSource(file) && file !== COMPOSITION_ROOT,
    pattern: /\bnew AgentCapabilityStore\b/g,
    message: 'agent 能力表只在组合根造一份，经 Context 下发，不要在渲染层新建',
  },
  {
    id: 'framework-free-domain',
    appliesTo: (file) => FRAMEWORK_FREE_ROOTS.some((root) => file.startsWith(root)),
    pattern: /(?<=(?:from|import)\s*\(?\s*['"])react(?:-dom)?(?=['"/])/g,
    message: 'domain 不认识 React：hooks 与 Context 归 UI 包，投影与状态要能在 Node 里单测',
  },
  ...entryOwnershipRules,
  {
    id: 'design-system-token-authority',
    appliesTo: inDirectory('packages/ui/src'),
    pattern: new RegExp(
      '(?<![\\w-])(?:' +
        alternation(restrictedUtilityClasses.map((rule) => rule.token)) +
        ')(?![\\w-])',
      'g',
    ),
    message: 'design-system components must consume --ui-* tokens instead of raw utility classes',
    hint: (match) =>
      restrictedUtilityClasses.find((rule) => rule.token === match)?.replacement ?? null,
  },
  ...governanceRules,
]
