#!/usr/bin/env bun
/*
 * 把 packages/agent-bridge 编成一个单文件可执行，随 Tauri 一起发。
 *
 * 用户因此不需要装 omp、不需要装 Bun、不需要 node_modules —— 只装 Poietica。
 *
 * 配方照 omp 官方的 scripts/compile-binary.ts（同一条 Bun.build + compile 路），
 * 两处不同，都是有理由的：
 *
 * 1. 上游用内存插件供给 `omp-legacy-pi-modules`（跑旧 Pi 扩展要用）。嵌入方不跑
 *    旧扩展，这里给一个空注册表，省掉它那套按 exports 通配展开的枚举。
 * 2. 上游从仓库 docs/ 现生成文档索引；npm 包里没有 docs/，用它预生成的那一份。
 */

import { mkdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const ROOT = path.resolve(import.meta.dir, '../..')
const PACKAGE = path.join(ROOT, 'packages/agent-bridge')
/* SDK 装在包自己的 node_modules 里（Bun 的工作区提升不跨 optional 依赖）。 */
const SDK = path.join(PACKAGE, 'node_modules/@oh-my-pi/pi-coding-agent')

/** 出到 externalBin 认的名字：Tauri 要求 `<名>-<target triple>` 后缀。 */
const OUT = path.join(ROOT, 'apps/desktop/src-tauri/binaries')

/** 宿主 triple。Tauri 按它找边车，名字对不上就在打包时报缺文件。 */
function hostTriple(): string {
  const asked = process.env['POIETICA_BRIDGE_TRIPLE']
  if (asked !== undefined && asked !== '') {
    return asked
  }

  const probed = Bun.spawnSync(['rustc', '-vV'], { stdout: 'pipe' })
  const host = /^host:\s*(\S+)$/m.exec(probed.stdout.toString())?.[1]

  if (host === undefined) {
    throw new Error('读不出宿主 target triple：装好 rustc，或设 POIETICA_BRIDGE_TRIPLE')
  }

  return host
}

async function main(): Promise<void> {
  const jsonPlugin = await import(path.join(SDK, 'scripts/json-parse-plugin.ts'))

  const docsEmbed = await readFile(path.join(SDK, 'dist/docs-index.generated.txt'), 'utf8')

  /*
   * User-Agent 是 omp 给厂商请求打的指纹（pi-utils 的 USER_AGENT = `omp/<版本>`）。
   * 从 SDK 自己的清单读版本，不去 import 那个包：工作区用 Bun 的隔离式安装，
   * 兄弟包的解析路径不保证可达，而这一格只是个字符串。
   */
  const { version: agentVersion } = JSON.parse(
    await readFile(path.join(SDK, 'package.json'), 'utf8'),
  ) as { version: string }

  /*
   * 微小模型（标题生成）的 worker 首次用到时自己去装 transformers；那个版本号是
   * 编进二进制的提示。我们不开 hasUI，走不到那条路，但把 define 留着以免它读到
   * 未定义值。装不到就报空串：那条路本来就会自己装。
   */
  const transformersVersion = await readFile(
    path.join(PACKAGE, 'node_modules/@huggingface/transformers/package.json'),
    'utf8',
  )
    .then((text) => (JSON.parse(text) as { version: string }).version)
    .catch(() => '')

  const target = process.env['POIETICA_BRIDGE_TARGET']
  const triple = hostTriple()
  const suffix = triple.includes('windows') ? '.exe' : ''
  const outfile = path.join(OUT, `poietica-agent-${triple}${suffix}`)

  await mkdir(OUT, { recursive: true })

  const started = Date.now()
  const built = await Bun.build({
    entrypoints: [path.join(PACKAGE, 'src/main.ts')],
    root: ROOT,
    /* 这两个是可选的重型原生依赖，按需在运行时装，不进二进制。 */
    external: ['fastembed', 'onnxruntime-node'],
    define: {
      'process.env.PI_COMPILED': JSON.stringify('true'),
      'process.env.PI_TINY_TRANSFORMERS_VERSION': JSON.stringify(transformersVersion),
      'process.env.PI_DOCS_EMBED': JSON.stringify(docsEmbed),
    },
    format: 'esm',
    bytecode: true,
    minify: { identifiers: false, keepNames: true },
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
    compile: {
      execArgv: [`--user-agent=omp/${agentVersion}`],
      ...(target === undefined ? {} : { target: target as never }),
      outfile,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    throw: false,
  })

  if (!built.success) {
    for (const log of built.logs) {
      console.error(`[${log.level}] ${log.message}`)
    }
    throw new Error('agent bridge bundle failed')
  }

  console.log(`agent bridge built in ${String(Date.now() - started)} ms -> ${outfile}`)
}

await main()
