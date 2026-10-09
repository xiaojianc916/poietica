import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * 构建单个可执行文件 poietica-core.exe。
 *
 * 编译方式与 omp 官方的 scripts/compile-binary.ts 保持一致（omp 知识 #16）：
 * 同样的 target 与 autoload 开关、同样的 external、同样的 define 常量、
 * 同样的 json-parse 插件与 legacy-pi 模块桩插件（都从 omp 包内导入，不自己重写）。
 *
 * 所有产物输出到 apps/core/dist/（探针版为 dist-probe/），不直接写进 apps/desktop/resources：
 * 开发时 Host 直接从 dist 启动 Core；打包时由 electron-builder 的 extraResources 复制。
 *
 * 用法：
 *   bun apps/core/scripts/build.ts            正式版
 *   bun apps/core/scripts/build.ts --probe    探针版（POIETICA_PROBE_BUILD=1，接受 --probe-mock-model）
 */

const ROOT = path.resolve(import.meta.dir, '../../..')
const CORE_DIR = path.join(ROOT, 'apps/core')
const probe = process.argv.includes('--probe')
const outDir = path.join(CORE_DIR, probe ? 'dist-probe' : 'dist')
const pkg = JSON.parse(readFileSync(path.join(CORE_DIR, 'package.json'), 'utf8')) as { version: string }
// omp 装在 engine-omp 的 node_modules 里（bunfig 的 isolated linker 不 hoist），所以从那里解析
const ompRoot = path.resolve(
  Bun.resolveSync('@oh-my-pi/pi-coding-agent', path.join(ROOT, 'packages/engine-omp/src')),
  '..',
  '..',
)
const ompPkg = JSON.parse(readFileSync(path.join(ompRoot, 'package.json'), 'utf8')) as { version: string }

const exe = path.join(outDir, 'poietica-core.exe')

/**
 * omp 官方编译脚本用的两个插件 + 文档索引，都从 omp 包内导入（不自己重写）。
 *
 * legacy-pi 桩插件：omp 官方的 createLegacyPiVirtualModulePlugin 会去 `<repoRoot>/packages/<pkg>`
 * 扫源码来生成“旧 Pi 模块”的懒加载注册表 —— 那是 omp 自仓库的布局；安装到 node_modules 的
 * 发布版里没有 packages/，插件会以 ENOENT 失败。Poietica 不使用任何 legacy Pi 扩展导入，
 * 所以这里退化为一个桩：仍然提供 `omp-legacy-pi-modules` 这个虚拟模块，但注册表为空。
 */
async function ompBuildParts(): Promise<{ plugins: unknown[]; docs: string; legacyPi: 'omp' | 'stub' }> {
  const jsonParse = (await import(path.join(ompRoot, 'scripts/json-parse-plugin.ts'))) as {
    createJsonParsePlugin: () => unknown
  }
  const docsIndex = (await import(path.join(ompRoot, 'scripts/generate-docs-index.ts'))) as {
    buildDocsIndexPayload: () => Promise<{ payload: string }>
  }
  const plugins: unknown[] = [jsonParse.createJsonParsePlugin()]
  let legacyPi: 'omp' | 'stub' = 'omp'
  try {
    const mod = (await import(path.join(ompRoot, 'scripts/legacy-pi-virtual-module.ts'))) as {
      createLegacyPiVirtualModulePlugin: () => Promise<unknown>
      LEGACY_PI_MODULES_SPECIFIER: string
    }
    plugins.push(await mod.createLegacyPiVirtualModulePlugin())
  } catch (e) {
    legacyPi = 'stub'
    console.warn(`[build] omp 的 legacy-pi 插件不可用（${String(e)}），改用空注册表桩`)
    plugins.push(createLegacyPiStubPlugin())
  }
  return { plugins, docs: await docsPayload(docsIndex), legacyPi }
}

/**
 * 文档索引。omp 的生成器读 `<包>/../../docs` —— 发布版里那一级不存在（是 omp 自仓库的布局），
 * 所以读失败时退化为空索引：`PI_DOCS_EMBED` 为空字符串，omp 的文档工具会认为没有内嵌文档。
 * 这不会影响任何对话功能。
 */
async function docsPayload(mod: { buildDocsIndexPayload: () => Promise<{ payload: string }> }): Promise<string> {
  try {
    return (await mod.buildDocsIndexPayload()).payload
  } catch (e) {
    console.warn(`[build] omp 的文档索引不可用（${String(e)}），PI_DOCS_EMBED 置空`)
    return ''
  }
}

/** 空注册表的 legacy-pi 桩：Poietica 不使用任何 legacy Pi 扩展导入 */
function createLegacyPiStubPlugin(): unknown {
  const specifier = 'omp-legacy-pi-modules'
  return {
    name: 'poietica:legacy-pi-stub',
    setup(build: {
      onResolve: (o: { filter: RegExp }, cb: () => unknown) => void
      onLoad: (o: { filter: RegExp; namespace: string }, cb: () => unknown) => void
    }) {
      build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
        path: 'empty',
        namespace: 'poietica-legacy-pi-stub',
      }))
      build.onLoad({ filter: /.*/, namespace: 'poietica-legacy-pi-stub' }, () => ({
        contents: 'export const BUNDLED_PI_MODULE_LOADERS = {};\n',
        loader: 'ts',
      }))
      void specifier
    },
  }
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const { plugins, docs, legacyPi } = await ompBuildParts()
const result = await Bun.build({
  entrypoints: [path.join(CORE_DIR, 'src/main.ts')],
  root: ROOT,
  compile: {
    target: 'bun-windows-x64-baseline', // baseline 兼容不支持 AVX2 的旧 CPU
    outfile: exe,
    // 编译产物默认会自动加载 cwd 下的这些文件，是隔离漏洞（04 页 §3.3 第 6 条）
    autoloadDotenv: false,
    autoloadBunfig: false,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
  format: 'esm',
  bytecode: true, // 启动时跳过约 20 MB bundle 的解析
  minify: { identifiers: false, keepNames: true }, // 保留函数名，错误栈才可读
  external: ['fastembed', 'onnxruntime-node'], // 与 omp 官方一致：重型可选依赖不打包
  define: {
    'process.env.PI_COMPILED': JSON.stringify('true'),
    'process.env.POIETICA_BUILD_VERSION': JSON.stringify(pkg.version),
    'process.env.PI_DOCS_EMBED': JSON.stringify(docs),
    'process.env.POIETICA_PROBE_BUILD': JSON.stringify(probe ? '1' : '0'),
    // omp 的版本：编译期注入。运行时读不到（见 packages/engine-omp/src/omp-version.ts 的说明）
    'process.env.POIETICA_OMP_VERSION': JSON.stringify(ompPkg.version),
  },
  plugins: plugins as never,
  throw: false,
})

if (!result.success) {
  for (const log of result.logs) console.error(String(log))
  process.exit(1)
}

// 复制 natives：从 @oh-my-pi/pi-natives-win32-x64 包复制两个 .node 到 exe 同目录。
// 为什么能保证加载的是这一份：natives 加载器在编译模式下按 <natives 目录>/<版本>/ → <natives 目录>/ → exe 所在目录
// 的顺序查找；前两个目录都在隔离根下而且为空，所以最终加载的一定是随包发布的这一份。
// natives 包由 @oh-my-pi/pi-natives 以 optionalDependency 拉进来（isolation linker 不 hoist），
// 所以从 node_modules/.bun 下按名字找它
const nativesCandidate = path.join(ROOT, 'node_modules/.bun')
const resolvedNatives = (() => {
  const dirs = readdirSync(nativesCandidate).filter((d) => d.startsWith('@oh-my-pi+pi-natives-win32-x64@'))
  for (const d of dirs) {
    const candidate = path.join(nativesCandidate, d, 'node_modules/@oh-my-pi/pi-natives-win32-x64')
    if (existsSync(candidate)) return candidate
  }
  return path.join(ROOT, 'node_modules/@oh-my-pi/pi-natives-win32-x64')
})()

const nativeFiles = ['pi_natives.win32-x64-modern.node', 'pi_natives.win32-x64-baseline.node']
for (const name of nativeFiles) {
  const from = path.join(resolvedNatives, name)
  if (existsSync(from)) copyFileSync(from, path.join(outDir, name))
  else console.warn(`[build] 缺少 natives：${name}（找的是 ${resolvedNatives}）`)
}

// core-manifest.json：每个产物文件的 sha256，供发布与排查使用
const emitted = [path.basename(exe), ...nativeFiles].filter((n) => existsSync(path.join(outDir, n)))
const sha256: Record<string, string> = {}
for (const f of emitted)
  sha256[f] = createHash('sha256')
    .update(readFileSync(path.join(outDir, f)))
    .digest('hex')
const { PROTOCOL_VERSION } = (await import('@poietica/protocol')) as { PROTOCOL_VERSION: number }
writeFileSync(
  path.join(outDir, 'core-manifest.json'),
  `${JSON.stringify(
    {
      coreVersion: pkg.version,
      protocolVersion: PROTOCOL_VERSION,
      ompVersion: ompPkg.version,
      probe,
      legacyPiPlugin: legacyPi,
      builtAt: new Date().toISOString(),
      sha256,
    },
    null,
    2,
  )}\n`,
)
console.log(`[build] ${probe ? '探针版' : '正式版'} 构建完成：${path.relative(ROOT, exe)}（${emitted.length} 个文件）`)
