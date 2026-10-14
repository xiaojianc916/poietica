import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin, Rollup } from 'vite'

type OutputChunk = Rollup.OutputChunk

/**
 * electron-vite 会分别构建 main、preload、renderer 三份产物，每份的要求不同：
 *
 * - main 用 externalizeDepsPlugin()（默认参数）：它只外部化 dependencies 里的包
 *   （最终只有 @lydell/node-pty 与 electron-updater），再加上 electron 本身；其余依赖都在
 *   devDependencies，会被打进 bundle。工作区包的 exports 指向 TS 源码，正因为如此它们必须
 *   放 devDependencies 被打包，不能外部化。
 *
 *   **实测补丁**：只靠 externalizeDepsPlugin 时 @lydell/node-pty 仍被内联进
 *   out/main/index.cjs（它从 features/terminal 的源码进来，插件按「离构建根最近的那个
 *   package.json」判依赖，工作区包的依赖不在那张表里）。内联之后它的 requireBinary() 变成
 *   「从 out/main 找 @lydell/node-pty-win32-x64」—— 那个二进制包不在 apps/desktop/node_modules
 *   下，于是 terminal.open 每次都以 terminal.spawn_failed 失败（真机日志：
 *   "could not find the binary package for it: @lydell/node-pty-win32-x64/conpty.node"）。
 *   所以原生 PTY 这两个包显式写进 ssr.external —— 与 electron 同一条理由：留在外部的包
 *   必须真的能在运行时被 require 到（它们在 apps/desktop 的 dependencies 里，随包发货）。
 * - preload 不用 externalizeDepsPlugin，输出 cjs 单文件：sandbox 模式下的 preload 只能是
 *   CommonJS，而且除了 electron 的少数模块不能 require 任何东西。
 * - renderer 用 React 插件，加上 cspPlugin 把 index.html 的 %POIETICA_CSP% 换成对应环境的 CSP。
 */

/**
 * 开发版：与安装版同一张策略表（06 页 §4.8），只额外放开 Vite HMR 需要的两处 ——
 * `script-src` 的 'unsafe-inline'（React 刷新前导脚本）与 `connect-src` 的 localhost websocket。
 *
 * img-src 里放行 avatars.githubusercontent.com：代码审查页要画 GitHub 的作者头像，而这张表是
 * 白名单 —— 不给这一条，图片会被 Chromium 静默拦掉（页面只是没有头像，控制台才有一条 CSP 报告）。
 * 只放行这一个头像主机，不放行任意 https。
 *
 * 'wasm-unsafe-eval' 是产品需要，不是开发版特权：diff 的语法着色走 shiki，它的
 * oniguruma 引擎是 WebAssembly；不给这条，Chromium 直接拒绝编译 WASM，着色静默
 * 退化成一堆没有颜色的正文（真机上就是这么冒出来的）。它只放行 WASM 编译，不等于
 * 'unsafe-eval'，两者别混。审查面板的 worker 与工具抽屉的主线程都吃这张表。
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
  'frame-src poietica-asset://widget http://localhost:* http://127.0.0.1:*',
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
  'frame-src poietica-asset://widget http://localhost:* http://127.0.0.1:*',
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
 * 首屏入口闭包的守卫（性能审查 P-06）。
 *
 * 入口分块及其静态 import 链上的所有分块，渲染进程都要下载、解析、编译、求值完才能画第一帧。
 * 下面这些包只在交互之后才用得到（公式、终端、看大图），已经改成动态 import；谁再把它们
 * 静态带回入口，构建直接失败 —— 而不是等用户觉得启动又慢了。
 *
 * 体积只告警不失败：功能正常增长不该卡住构建，但每次越线都应该有人看一眼是谁涨的。
 */
const DEFERRED_PACKAGES = ['/node_modules/katex/', '/node_modules/@xterm/', '/node_modules/yet-another-react-lightbox/']
/** 入口静态闭包的体积告警线：P-06 之后约 5.11MB，留约 5% 余量 */
const ENTRY_BUDGET_BYTES = 5_400_000

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

/** 闭包里出现了哪些「应当按需」的包：每个包一行，带上它落在哪些分块里 */
function deferredIn(closure: readonly OutputChunk[]): string[] {
  const hits = new Map<string, Set<string>>()
  for (const chunk of closure) {
    for (const id of chunk.moduleIds) {
      const pkg = DEFERRED_PACKAGES.find((name) => id.replaceAll('\\', '/').includes(name))
      if (pkg !== undefined) hits.set(pkg, (hits.get(pkg) ?? new Set()).add(chunk.fileName))
    }
  }
  return [...hits].map(([pkg, files]) => `  ${pkg} ← ${[...files].join(', ')}`)
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
        this.error(`这些按需加载的包被静态带进了首屏入口（见 P-06）：\n${offenders.join('\n')}`)
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
      plugins: [externalizeDepsPlugin()],
      /*
       * 原生 PTY 必须留在外部：@lydell/node-pty 的 requireBinary() 是按**包的相对位置**
       * require('@lydell/node-pty-<platform>-<arch>/conpty.node') 的，只有包本体留在
       * node_modules 里、且平台二进制包与它相邻时这条解析才成立。内联进 bundle 之后
       * 解析起点变成 out/main，二进制包找不到 —— 终端一开就 spawn_failed。
       */
      ssr: { external: ['@lydell/node-pty', '@lydell/node-pty-win32-x64'] },
      build: {
        // electron 必须外部化：它在 devDependencies 里（由 vite 打进 bundle 的都是 devDependencies），
        // 而 externalizeDepsPlugin 只外部化 dependencies。少了这一条，打包器会把 npm 上的 electron
        // **安装器** 打进来，它在 require 时就去 spawn install.js 并抛
        // "Electron failed to install correctly"（真实故障：bun run dev 以退出码 3 结束）。
        outDir: path.join(__dirname, 'out/main'),
        lib: { entry: path.join(__dirname, 'src/main/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
        rollupOptions: {
          external: ['electron', /^electron\/.+/],
          output: { entryFileNames: 'index.cjs' },
        },
      },
    },
    preload: {
      build: {
        outDir: path.join(__dirname, 'out/preload'),
        lib: { entry: path.join(__dirname, 'src/preload/index.ts'), formats: ['cjs'], fileName: () => 'index.cjs' },
        rollupOptions: {
          // 业务依赖全部打进这一个文件（sandbox 下的 preload 只能是自包含的单文件 CJS），
          // 但 electron 本身必须外部化：它在 devDependencies 里，不外部化就会把 npm 上的
          // electron **安装器** 打进来，它在顶层 require("child_process") —— sandbox 里没有这个模块，
          // preload 直接报 "module not found: child_process"，bridge 不会挂上，
          // 渲染进程随后抛 "preload 没有暴露 bridge"，整个外壳渲染不出来（真实故障）。
          external: ['electron', /^electron\/.+/],
          output: { entryFileNames: 'index.cjs' },
        },
      },
    },
    renderer: {
      root: path.join(__dirname, 'src/renderer'),
      /*
       * 开发期不要 Vite 自带的那个红色错误浮层。
       *
       * 它是 vite 的默认行为（全屏遮罩 + 栈），不属于本产品的界面语言：本仓的错误面有三层，
       * 各管各的 —— 内核把功能装载失败收进 `kernel.failures` 并由外壳画成横幅里的「N 个功能
       * 加载失败」；UI 内核的 FeatureErrorBoundary 把某个功能渲染期的异常收在它自己的格子里
       * （06 页 §5.3）；Core 侧的问题走平台横幅。这层遮罩一盖，那三处全都看不见了。
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
        rollupOptions: { input: path.join(__dirname, 'src/renderer/index.html') },
      },
    },
  }
})
