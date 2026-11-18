import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { CORE_ARTIFACTS, CORE_NATIVE_ARTIFACTS, CORE_OPTIONAL_NATIVE_ARTIFACTS } from './artifacts'

/**
 * 构建单个可执行文件 poietica-core.exe。编译方式与 omp 官方的 scripts/compile-binary.ts
 * 保持一致（omp 知识 #16）：同样的 target 与 autoload 开关、external、define 常量与插件
 * （都从 omp 包内导入，不自己重写）。产物输出到 apps/core/dist/（探针版为 dist-probe/），
 * 不直接写进 apps/desktop/resources：开发时 Host 直接从 dist 启动，打包时由 extraResources 复制。
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
const runtimeExe = path.join(outDir, 'poietica-runtime.exe')

function createLegacyPiEmptyRegistryPlugin(): unknown {
  return {
    name: 'poietica:legacy-pi-empty',
    setup(build: {
      onResolve: (o: { filter: RegExp }, cb: () => unknown) => void
      onLoad: (o: { filter: RegExp; namespace: string }, cb: () => unknown) => void
    }) {
      build.onResolve({ filter: /^omp-legacy-pi-modules$/ }, () => ({
        path: 'empty',
        namespace: 'poietica-legacy-pi-empty',
      }))
      build.onLoad({ filter: /.*/, namespace: 'poietica-legacy-pi-empty' }, () => ({
        contents: 'export const BUNDLED_PI_MODULE_LOADERS = {};\n',
        loader: 'ts',
      }))
    },
  }
}

async function ompBuildPlugins(): Promise<{ plugins: unknown[]; docs: string }> {
  const jsonParse = (await import(path.join(ompRoot, 'scripts/json-parse-plugin.ts'))) as {
    createJsonParsePlugin: () => unknown
  }
  const docsIndex = (await import(path.join(ompRoot, 'scripts/generate-docs-index.ts'))) as {
    buildDocsIndexPayload: () => Promise<{ payload: string }>
  }
  return {
    plugins: [jsonParse.createJsonParsePlugin(), createLegacyPiEmptyRegistryPlugin()],
    docs: await docsPayload(docsIndex),
  }
}

/**
 * omp 的文档索引生成器读 `<包>/../../docs` —— 那是它 monorepo 的布局，npm 安装形态下不存在，必然 ENOENT。
 * 此时不能退化成空 `PI_DOCS_EMBED`：编译后的 exe 里 `import.meta.dir` 指向虚拟快照根，omp 回退读
 * `dist/docs-index.generated.txt` 必然找不到，`omp://` 就成了「No documentation files found」。
 * npm 包恰好带着这份生成好的索引，直接把它作为 embed 注入即可。
 */
async function docsPayload(mod: { buildDocsIndexPayload: () => Promise<{ payload: string }> }): Promise<string> {
  try {
    return (await mod.buildDocsIndexPayload()).payload
  } catch {
    try {
      return readFileSync(path.join(ompRoot, 'dist/docs-index.generated.txt'), 'utf8')
    } catch {
      return ''
    }
  }
}

rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const { plugins, docs } = await ompBuildPlugins()

async function compile(entrypoint: string, outfile: string, defineProbe: boolean): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entrypoint],
    root: ROOT,
    compile: {
      target: 'bun-windows-x64-baseline',
      outfile,
      autoloadDotenv: false,
      autoloadBunfig: false,
      autoloadTsconfig: false,
      autoloadPackageJson: false,
    },
    format: 'esm',
    bytecode: true,
    minify: { identifiers: false, keepNames: true },
    external: ['fastembed', 'onnxruntime-node'],
    define: {
      'process.env.PI_COMPILED': JSON.stringify('true'),
      'process.env.POIETICA_BUILD_VERSION': JSON.stringify(pkg.version),
      'process.env.PI_DOCS_EMBED': JSON.stringify(docs),
      'process.env.POIETICA_PROBE_BUILD': JSON.stringify(defineProbe ? '1' : '0'),
      'process.env.POIETICA_OMP_VERSION': JSON.stringify(ompPkg.version),
    },
    plugins: plugins as never,
    throw: false,
  })
  if (!result.success) {
    for (const log of result.logs) console.error(String(log))
    process.exit(1)
  }
}

await compile(path.join(CORE_DIR, 'src/main.ts'), exe, probe)
/* Core 与 Runtime 分开编译：omp 实现只进 runtime，Core 这边不应因动态 import 再拖进来。 */
await compile(path.join(CORE_DIR, 'src/runtime-entry.ts'), runtimeExe, probe)

// 复制 natives：加载器按 <natives 目录>/<版本>/ → <natives 目录>/ → exe 所在目录 的顺序查找，前两个
// 目录都在隔离根下而且为空，所以最终加载的一定是随包发布的这一份。natives 包由 @oh-my-pi/pi-natives
// 以 optionalDependency 拉进来（isolation linker 不 hoist），所以从 node_modules/.bun 下找它 ——
// 但只能要**这次装进来的那个版本**：bun install 不清理旧版本的 .bun 目录，readdir 先撞上旧版时，
// 随包的 .node 会和加载器版本不符，编译出来的 Core 启动即失败（加载器会报「reports 18.12.6, not 18.14.2」）。
const nativesCandidate = path.join(ROOT, 'node_modules/.bun')
const nativesVersion = (() => {
  const installed = path.join(ompRoot, 'node_modules/@oh-my-pi/pi-natives/package.json')
  if (!existsSync(installed)) return ompPkg.version
  const installedPkg = JSON.parse(readFileSync(installed, 'utf8')) as { version: string }
  return installedPkg.version
})()
const expectedNatives = path.join(
  nativesCandidate,
  `@oh-my-pi+pi-natives-win32-x64@${nativesVersion}`,
  'node_modules/@oh-my-pi/pi-natives-win32-x64',
)
const resolvedNatives = existsSync(expectedNatives)
  ? expectedNatives
  : (() => {
      const dirs = readdirSync(nativesCandidate).filter((d) => d.startsWith('@oh-my-pi+pi-natives-win32-x64@'))
      for (const d of dirs) {
        const candidate = path.join(nativesCandidate, d, 'node_modules/@oh-my-pi/pi-natives-win32-x64')
        if (existsSync(candidate)) return candidate
      }
      return path.join(ROOT, 'node_modules/@oh-my-pi/pi-natives-win32-x64')
    })()

const nativeFiles = CORE_NATIVE_ARTIFACTS
for (const name of nativeFiles) {
  const from = path.join(resolvedNatives, name)
  if (existsSync(from)) copyFileSync(from, path.join(outDir, name))
  else
    throw new Error(
      `[build] 缺少必需 natives：${name}（${nativesVersion} 的目录 ${expectedNatives}，实际找的是 ${resolvedNatives}），不能发布不完整的 Core`,
    )
}
// 上游当前只发布 baseline（package.json 的 main 也指向它）；modern 若存在就顺手带上。
const optionalNativeFiles = CORE_OPTIONAL_NATIVE_ARTIFACTS.filter((name) =>
  existsSync(path.join(resolvedNatives, name)),
)
for (const name of optionalNativeFiles) copyFileSync(path.join(resolvedNatives, name), path.join(outDir, name))

// core-manifest.json：每个产物文件的 sha256，供发布与排查使用
const emitted = [...CORE_ARTIFACTS, ...optionalNativeFiles]
const sha256: Record<string, string> = {}
for (const f of emitted) sha256[f] = Bun.SHA256.hash(readFileSync(path.join(outDir, f)), 'hex')
const { PROTOCOL_VERSION } = (await import('@poietica/protocol')) as { PROTOCOL_VERSION: number }
writeFileSync(
  path.join(outDir, 'core-manifest.json'),
  `${JSON.stringify(
    {
      coreVersion: pkg.version,
      protocolVersion: PROTOCOL_VERSION,
      ompVersion: ompPkg.version,
      probe,
      builtAt: new Date().toISOString(),
      sha256,
    },
    null,
    2,
  )}\n`,
)
console.log(`[build] ${probe ? '探针版' : '正式版'} 构建完成：${path.relative(ROOT, exe)}（${emitted.length} 个文件）`)
