#!/usr/bin/env bun
/*
 * 摆好 agent 运行时的三样东西，交给 Tauri 的 bundle.resources 原样摆进安装目录
 * （与应用可执行文件同目录）：随包的 bun.exe、桥的 bundle、pi-natives 的 .node。
 *
 * 不产出自有编译产物：omp SDK 的宿主就是 Bun —— engines 只写 bun，官方 docs/sdk.md
 * 写的是「从 Bun 进程里 createAgentSession()」。配方照官方 scripts/bundle-dist.ts
 * （同一条 Bun.build + target:'bun' 路），两处不同：`omp-legacy-pi-modules` 插件从
 * 仓库 packages/* 现枚举而 npm 包里没有，嵌入方也不跑旧扩展，给空注册表；文档索引
 * 用 npm 包预生成的那一份（包里没有 docs/）。
 *
 * 不带 target triple：资源 map 的 target 是裸文件名，平台只按 process.platform/
 * process.arch 挑 pi-natives 叶子包（与加载器同一条式子），所以不需要 Rust 工具链。
 * 不折 `PI_COMPILED`（那是 `--compile` 的自述，我们是普通 Bun 进程），并在档案里把
 * 这一格从子进程环境摘掉（packages/agent-catalog/src/omp/descriptor.ts）。
 */

import { readFileSync, realpathSync } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dir, '../..')
const PACKAGE = path.join(ROOT, 'packages/agent-bridge')
/* SDK 装在包自己的 node_modules 里（Bun 的工作区提升不跨 optional 依赖）。 */
const SDK = path.join(PACKAGE, 'node_modules/@oh-my-pi/pi-coding-agent')
const OUT = path.join(ROOT, 'apps/desktop/src-tauri/binaries')

/*
 * 桥的 bundle 名。正本是 packages/agent-catalog/src/omp/descriptor.ts 的 `entry` ——
 * 那是启动时唯一被读的一份，改名必须两处同改。
 */
const BUNDLE = 'poietica-bridge.js'

/**
 * 平台叶子包名。
 *
 * 与加载器同一条式子（`native/loader-state.js:880` 的 `` `${platform}-${process.arch}` ``），
 * 不是 rustc 的 target triple：加载器只认 Node 的 `process.platform`，而随包跑的正是
 * Node 意义上的 Bun。读 triple 会让这个脚本平白依赖 Rust 工具链（`bun dev` 装不了）。
 */
function nativeLeafPackage(): string {
  const tag = `${process.platform}-${process.arch}`

  if (!['linux', 'darwin', 'win32'].includes(process.platform)) {
    throw new Error(`这套平台没有 pi-natives 的预编译包：${tag}`)
  }

  return `pi-natives-${tag}`
}

/*
 * 叶子包里的那个 `.node`：源路径与文件名都从**它自己的清单**读 `main`。
 *
 * 不自己拼名字：x64 上有 `-baseline` 与 `-modern` 之分，叶子包已在 `main` 里声明
 * 自己是哪一个，再列一张表就是第二个事实。落点不是固定路径 —— bun 的隔离式安装
 * 把它放在 `pi-natives` 自己的 node_modules 里，工作区提升不跨它。所以按加载器
 * 自己的办法（loader-state.js 的 resolveLeafPackageDir）从 `pi-natives` 的入口
 * `require.resolve`，找不到就报错，不猜路径。
 */
function leafAddon(leaf: string): { source: string; name: string } {
  /*
   * 两级解析，各自从能看见它的那一层出发：
   * 1. `pi-natives` 是 SDK 的依赖 —— 工作区里 `@oh-my-pi/pi-coding-agent` 是一条符号
   *    链接，要先 realpath，require 才走得到链接目标那一侧的兄弟目录；
   * 2. 平台叶子包是 `pi-natives` 的 **optional** 依赖，装在 `pi-natives` 自己的
   *    `node_modules` 里，从 SDK 那边看不见。
   */
  const fromSdk = createRequire(realpathSync(path.join(SDK, 'package.json')))
  const nativesEntry = fromSdk.resolve('@oh-my-pi/pi-natives/package.json')
  const leafManifest = createRequire(nativesEntry).resolve(`@oh-my-pi/${leaf}/package.json`)

  /* `main` 就是它自己那个 `.node`：叶子包只发这一个文件加许可证。 */
  const manifest = JSON.parse(readFileSync(leafManifest, 'utf8')) as { main?: unknown }
  const name = typeof manifest.main === 'string' ? path.basename(manifest.main) : ''

  if (name === '') {
    throw new Error(`${leaf} 的清单没有说它的原生模块叫什么：${leafManifest}`)
  }

  return { source: path.join(path.dirname(leafManifest), name), name }
}

/*
 * 上一次跑的产物必须清掉：bundle 带出的静态资源是内容哈希命名的
 * （template-<hash>.css 等），不清就越积越多。只删条目不删 OUT 自己 ——
 * 本机它是一个 junction，删掉等于拆掉既定构建布局。
 */
async function cleanOutputs(): Promise<void> {
  const entries = await readdir(OUT, { withFileTypes: true }).catch(() => [])

  for (const entry of entries) {
    await rm(path.join(OUT, entry.name), { recursive: entry.isDirectory(), force: true })
  }
}

async function main(): Promise<void> {
  const entry = path.join(PACKAGE, 'src/main.ts')
  const jsonPlugin = await import(path.join(SDK, 'scripts/json-parse-plugin.ts'))

  const docsEmbed = await readFile(path.join(SDK, 'dist/docs-index.generated.txt'), 'utf8')

  /*
   * 三件输入全部先解析出来，**再**动输出目录：反过来，任何一次「找不到叶子包」
   * 的失败都会先删掉上一次备好的运行时，留下半成品目录 —— bundle.resources 少一个
   * 文件是构建失败，不是静默漏包。
   */
  const addon = leafAddon(nativeLeafPackage())

  await stat(addon.source)

  await mkdir(OUT, { recursive: true })
  await cleanOutputs()

  const started = Date.now()
  const built = await Bun.build({
    entrypoints: [entry],
    /* 入口扁平落盘（下面的 rename 只改名字，不改目录）：静态资源也落在同一层。 */
    root: path.dirname(entry),
    /* 桥跑在 Bun 里，不是浏览器也不是 Node：SDK 有 `bun:sqlite` 与 Bun 内置模块。 */
    target: 'bun',
    /* 这两个是可选的重型原生依赖，按需在运行时装，不进包。 */
    external: ['fastembed', 'onnxruntime-node'],
    /*
     * 文档索引必须在这里折进去：bundle 不是编译产物，运行时既没有 dist/ 也没有
     * 仓库 docs/，那两处回落都会落空（docs-index.ts 的 readShippedEmbed /
     * readDocsFromDisk），omp:// 因此退化成空索引。
     *
     * 不折 PI_COMPILED：那是 `--compile` 的自述，而我们就是普通 Bun 进程。
     */
    define: {
      'process.env.PI_DOCS_EMBED': JSON.stringify(docsEmbed),
    },
    format: 'esm',
    minify: { identifiers: false, keepNames: true },
    /*
     * **分块**：不这么写，35MB 全落在一个入口文件里，Bun 启动时要读进来、解析完
     * 才能执行第一行 —— 入口那一趟（写 ready、答 selectors/skills/mcp_servers）
     * 因此白等整片 main/modes 的编译钱。
     *
     * 分块之后入口只有 0.2MB，重的那片（sdk / modes/runtime-init）落成独立 chunk，
     * 按 `import()` 到用时才加载。实测 spawn→ready 从 ~800ms 掉到 ~615ms，
     * 「点开新对话 → 工具条有值」从 ~970ms 掉到 ~795ms。
     *
     * 代价是产物从 1 个 JS 变成几百个 chunk-*.js（都落在同一层，Tauri 的资源 map
     * 用 glob 收）。相对入口那一屏的启动钱，这个代价值得。
     */
    splitting: true,
    plugins: [
      jsonPlugin.createJsonParsePlugin(),
      {
        name: 'poietica:legacy-pi-stub',
        setup(build) {
          build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
            path: 'omp-legacy-pi-modules',
            namespace: 'poietica-stub',
          }))
          build.onLoad({ filter: /.*/, namespace: 'poietica-stub' }, () => ({
            contents: 'export const BUNDLED_PI_MODULE_LOADERS = {};',
            loader: 'ts',
          }))
        },
      },
    ],
    outdir: OUT,
    throw: false,
  })

  if (!built.success) {
    for (const log of built.logs) {
      console.error(`[${log.level}] ${log.message}`)
    }
    throw new Error('agent bridge bundle failed')
  }

  await rename(path.join(OUT, 'main.js'), path.join(OUT, BUNDLE))

  /* 运行时就是**正在跑这个脚本的那只 Bun**：版本因此与锁定的 toolchain 一致。 */
  const runtime = path.join(OUT, path.basename(process.execPath))
  await copyFile(process.execPath, runtime)

  await copyFile(addon.source, path.join(OUT, addon.name))

  const written = new Set([BUNDLE, path.basename(runtime), addon.name])
  const assets = (await readdir(OUT)).filter((name) => !written.has(name)).sort()
  const megabytes = async (file: string): Promise<string> =>
    `${((await stat(file)).size / 1024 / 1024).toFixed(1)} MB`

  console.log(`agent runtime prepared in ${String(Date.now() - started)} ms`)
  console.log(`  ${path.basename(runtime)}  ${await megabytes(runtime)}`)
  console.log(`  ${BUNDLE}  ${await megabytes(path.join(OUT, BUNDLE))}`)
  console.log(`  ${addon.name}  ${await megabytes(path.join(OUT, addon.name))}`)
  console.log(`  + ${String(assets.length)} asset(s): ${assets.join(', ')}`)
}

await main()
