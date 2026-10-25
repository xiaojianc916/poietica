import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin, Rollup } from 'vite'

type OutputChunk = Rollup.OutputChunk

/**
 * 三份产物各有一份要求：
 * - main 用 build.externalizeDeps：只外部化 dependencies 里的包（最终只有 @lydell/node-pty 与
 *   electron-updater）；工作区包的 exports 指向 TS 源码，所以必须放 devDependencies 被打包。
 *   v5 的 externalizeDepsPlugin 只认「离构建根最近的 package.json」，从 features/terminal 进来的
 *   @lydell/node-pty 被内联后 requireBinary() 找不到 conpty.node，terminal.open 一律 spawn_failed；
 *   v6 作用在模块 id 上，不再依赖谁引入的，ssr.external 补丁随之删掉。
 * - preload 关掉 externalizeDeps，输出 cjs 单文件：sandbox 模式下除 electron 少数模块外不能 require。
 * - renderer 用 React 插件，加上 cspPlugin 把 index.html 的 %POIETICA_CSP% 换成对应环境的 CSP。
 */

/**
 * 开发版：与安装版同一张策略表（06 页 §4.8），只放开 Vite HMR 需要的两处 ——
 * `script-src` 的 'unsafe-inline'（React 刷新前导脚本）与 `connect-src` 的 localhost websocket。
 * img-src 只放行 avatars.githubusercontent.com 这一个头像主机（审查页要画 GitHub 头像，白名单
 * 不给这条图片会被静默拦掉）。'wasm-unsafe-eval' 是产品需要不是开发版特权：shiki 的 oniguruma
 * 引擎是 WebAssembly，不给这条着色静默退化成无色正文（真机实测）；它只放行 WASM 编译，别与
 * 'unsafe-eval' 混。审查面板的 worker 与工具抽屉的主线程都吃这张表。
 */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "img-src 'self' data: blob: poietica-asset: https://avatars.githubusercontent.com",
  "media-src 'self' blob: poietica-asset:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  'frame-src poietica-asset://intelligent-ui',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** 安装版：file: 协议下没有响应头，只能靠 meta；style-src 保留 unsafe-inline（内联样式来自组件库） */
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "img-src 'self' data: blob: poietica-asset: https://avatars.githubusercontent.com",
  "media-src 'self' blob: poietica-asset:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  'frame-src poietica-asset://intelligent-ui',
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function cspPlugin(isDev: boolean): Plugin {
  return {
    name: 'poietica:csp',
    transformIndexHtml(html) {
      return html.replace('%POIETICA_CSP%', isDev ? DEV_CSP : PROD_CSP)
    },
  }
}

/*
 * 首屏入口闭包的守卫（性能审查 P-06）：入口静态闭包要在画第一帧前下载、编译、求值完，
 * 下面这些只在交互后或正文上屏时才用到的模块（公式、终端、看大图、正文排版）已改成动态 import，
 * 谁再静态带回入口，构建直接失败。正文排版（性能方案 P5）约 2.4MB 在独立分块里首帧后预取；
 * 守卫按实现文件与最重的几个包各记一条，报错里直接是哪一条。体积只告警不失败。
 */
const DEFERRED_MODULES = [
  '/node_modules/katex/',
  '/node_modules/@xterm/',
  '/node_modules/yet-another-react-lightbox/',
  '/packages/design-system/src/prose/prose.tsx',
  '/node_modules/streamdown/',
  '/node_modules/parse5/',
  '/node_modules/shiki/',
  '/node_modules/@shikijs/',
  '/node_modules/pele/',
]
/** 有意留在首屏的样式表：streamdown 的样式随轻壳进主样式表、保住覆盖次序（见 prose-shell.tsx），不算带回 */
const STATIC_STYLES = ['/node_modules/streamdown/styles.css']
/** 入口静态闭包的体积告警线：P5 之后约 3.97MB，留约 5% 余量（P-06 之后曾是 5.11MB，P5 之前已涨到 6.39MB 而一直只是告警） */
const ENTRY_BUDGET_BYTES = 4_200_000

/** 从入口出发沿静态 import 走一遍（动态 import 不算：那是按需加载） */
function staticClosure(chunks: ReadonlyMap<string, OutputChunk>): OutputChunk[] {
  const entry = [...chunks.values()].find((chunk) => chunk.isEntry)
  const seen = new Map<string, OutputChunk>()
  const stack = entry === undefined ? [] : [entry]
  for (let chunk = stack.pop(); chunk !== undefined; chunk = stack.pop()) {
    if (seen.has(chunk.fileName)) continue
    seen.set(chunk.fileName, chunk)
    for (const name of chunk.imports) {
      const next = chunks.get(name)
      if (next !== undefined) stack.push(next)
    }
  }
  return [...seen.values()]
}

/** 闭包里出现了哪些「应当按需」的模块：每条一行，带上它落在哪些分块里 */
function deferredIn(closure: readonly OutputChunk[]): string[] {
  const hits = new Map<string, Set<string>>()
  for (const chunk of closure) {
    for (const id of chunk.moduleIds) {
      const path = id.replaceAll('\\', '/')
      if (STATIC_STYLES.some((style) => path.endsWith(style))) continue
      const hit = DEFERRED_MODULES.find((name) => path.includes(name))
      if (hit !== undefined) hits.set(hit, (hits.get(hit) ?? new Set()).add(chunk.fileName))
    }
  }
  return [...hits].map(([hit, files]) => `  ${hit} ← ${[...files].join(', ')}`)
}

function entryBudgetPlugin(): Plugin {
  return {
    name: 'poietica:entry-budget',
    apply: 'build',
    generateBundle(_options, bundle) {
      const chunks = new Map<string, OutputChunk>()
      for (const item of Object.values(bundle)) {
        if (item.type === 'chunk') chunks.set(item.fileName, item)
      }
      const closure = staticClosure(chunks)
      const offenders = deferredIn(closure)
      if (offenders.length > 0) {
        this.error(`这些按需加载的模块被静态带进了首屏入口（见 P-06、性能方案 P5）：\n${offenders.join('\n')}`)
      }
      const bytes = closure.reduce((sum, chunk) => sum + Buffer.byteLength(chunk.code), 0)
      if (bytes > ENTRY_BUDGET_BYTES) {
        this.warn(
          `首屏入口静态闭包 ${(bytes / 1e6).toFixed(2)}MB，超过告警线 ${(ENTRY_BUDGET_BYTES / 1e6).toFixed(2)}MB`,
        )
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const isDev = mode !== 'production'
  return {
    main: {
      build: {
        // electron-vite 6 起默认开启；显式写出来是因为这条行为决定 dependencies 是
        // 「运行时 require」还是「打进 bundle」，不该靠默认值兜底。
        externalizeDeps: true,
        outDir: path.join(__dirname, 'out/main'),
        lib: { entry: path.join(__dirname, 'src/main/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
        // electron 本身由 electron-vite 的 main preset 外部化（它不看 dependencies），
        // 否则会把 npm 上的 electron **安装器** 打进来。
        rolldownOptions: {
          output: { entryFileNames: 'index.cjs' },
        },
      },
    },
    preload: {
      build: {
        // preload 是 sandbox 下的自包含单文件 CJS：业务依赖必须全部内联，所以关掉
        // electron-vite 6 默认开启的 externalizeDeps（它会把 apps/desktop 的
        // dependencies 留成运行时 require）。electron 由 preload preset 外部化。
        externalizeDeps: false,
        outDir: path.join(__dirname, 'out/preload'),
        lib: { entry: path.join(__dirname, 'src/preload/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
        rolldownOptions: {
          output: { entryFileNames: 'index.cjs' },
        },
      },
    },
    renderer: {
      root: path.join(__dirname, 'src/renderer'),
      /*
       * 开发期关掉 Vite 自带的红色错误浮层：它是全屏遮罩 + 栈，不属于本产品的界面语言。
       * 本仓的错误面有三层（kernel.failures 横幅、FeatureErrorBoundary、平台横幅），
       * 这层遮罩一盖全都看不见了。
       */
      server: { hmr: { overlay: false } },
      // tailwindcss() 必须注册：`@import "tailwindcss"` 靠这个插件扫描源码、生成工具类。
      // 少了它，styles.css 只剩 tokens 与手写 CSS —— 界面上所有 .flex / .items-center /
      // .bg-sidebar 这类类名全部失效，整屏退化成没有样式的裸 HTML（真实故障）。
      // legacy 的 apps/desktop/electron.vite.config.ts 里同样是 react() + tailwindcss() 两个。
      plugins: [react(), tailwindcss(), cspPlugin(isDev), entryBudgetPlugin()],
      // 不加 alias：工作区包的 exports 直接指向 TS 源码，vite 通过 node_modules 软链解析即可；
      // 加 alias 会把 `@poietica/design-system/styles.css` 这类子路径也重写成 index.ts。
      build: {
        outDir: path.join(__dirname, 'out/renderer'),
        rolldownOptions: { input: path.join(__dirname, 'src/renderer/index.html') },
      },
    },
  }
})
