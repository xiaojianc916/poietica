import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import type { Plugin } from 'vite'

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
 * 'wasm-unsafe-eval' 是产品需要，不是开发版特权：diff 的语法着色走 shiki，它的
 * oniguruma 引擎是 WebAssembly；不给这条，Chromium 直接拒绝编译 WASM，着色静默
 * 退化成一堆没有颜色的正文（真机上就是这么冒出来的）。它只放行 WASM 编译，不等于
 * 'unsafe-eval'，两者别混。审查面板的 worker 与工具抽屉的主线程都吃这张表。
 */
const DEV_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
  "connect-src 'self' ws://localhost:* http://localhost:*",
  "img-src 'self' data: blob: poietica-asset:",
  "media-src 'self' blob: poietica-asset:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

/** 安装版：file: 协议下没有响应头，只能靠 meta；style-src 保留 unsafe-inline（内联样式来自组件库） */
const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "img-src 'self' data: blob: poietica-asset:",
  "media-src 'self' blob: poietica-asset:",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "frame-src 'none'",
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
      plugins: [react(), tailwindcss(), cspPlugin(isDev)],
      // 不加 alias：工作区包的 exports 直接指向 TS 源码，vite 通过 node_modules 软链解析即可；
      // 加 alias 会把 `@poietica/design-system/styles.css` 这类子路径也重写成 index.ts。
      build: {
        outDir: path.join(__dirname, 'out/renderer'),
        rollupOptions: { input: path.join(__dirname, 'src/renderer/index.html') },
      },
    },
  }
})
