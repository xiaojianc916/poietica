import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

import { customErrorDiagnosticsPlugin } from './vite-plugins/custom-error-diagnostics.ts'
import { elementPickerScriptPlugin } from './vite-plugins/element-picker-script.ts'

const { NODE_ENV: NODE_ENV_VALUE } = process.env

/*
 * 必须留在外部的运行时依赖。
 *
 * electron-vite 自带的 externalizeDepsPlugin 只读 package.json 的 dependencies，
 * 而 electron 是 devDependency（它本来就是开发期依赖 runtime 的包）。不显式写出来，
 * 打包器会把整个 electron 包内联进 main.cjs —— 内联后 __dirname 变成 dist-electron，
 * electron 包自己那句「二进制没装好就去跑 install.js」就指向不存在的路径，启动即炸。
 *
 * 反过来，不在这张表里的依赖会被内联进 dist-electron/**：electron-log 就是这条路上的，
 * 所以它住在 devDependencies 并随 main.cjs 发货。往这张表里加东西等于要求包里多一份
 * node_modules —— electron-builder 只装生产依赖，加错一个就是启动即报「模块找不到」。
 */
const RUNTIME_EXTERNALS = ['electron', 'electron-updater']

/* electron-vite 只读配置的 default 导出；规则例外登记在 biome.json 的 includes 白名单里。 */
export default defineConfig({
  main: {
    // elementPickerScriptPlugin 必须在 main 上：它跟的是「dist-electron 被清空」那次构建。
    plugins: [externalizeDepsPlugin(), elementPickerScriptPlugin()],
    // 见 RUNTIME_EXTERNALS：留在外部是主进程能起来的前提。
    ssr: { external: RUNTIME_EXTERNALS },
    build: {
      outDir: 'dist-electron',
      // Electron 44 内嵌 Node 24；不写就落到 electron-vite 那张只认到 39 的表上（未知版本会取到最老的一档）。
      target: 'node24',
      // 仓库是 "type": "module"，.js 会被当成 ESM；Electron 主进程与 sandbox preload 要的是 CJS。
      rollupOptions: {
        input: resolve(__dirname, 'electron/main.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name].cjs' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    ssr: { external: RUNTIME_EXTERNALS },
    build: {
      outDir: 'dist-electron',
      // main 先构建并清了目录；preload 与随后的 element-picker 都往同一个目录里加。
      // 不关掉这个，preload 一构建就把 main.cjs 删掉（Vite 的 outDir 相对 root 时默认清空）。
      emptyOutDir: false,
      target: 'node24',
      rollupOptions: {
        input: resolve(__dirname, 'electron/preload.ts'),
        output: { format: 'cjs', entryFileNames: '[name].cjs', chunkFileNames: '[name].cjs' },
      },
    },
  },
  // 渲染层沿用 vite.config.ts 的那一套：根就是 apps/desktop，index.html 在它下面。
  renderer: {
    root: __dirname,
    plugins: [
      // 必须最先注册，确保捕获后续插件及 import-analysis 错误。
      customErrorDiagnosticsPlugin(),
      react(),
      tailwindcss(),
    ],
    clearScreen: false,
    optimizeDeps: {
      include: ['@streamdown/mermaid'],
    },
    server: {
      port: 1420,
      strictPort: true,
      hmr: {
        // 使用 Poietica 自己的错误界面，禁止显示 Vite 默认 Overlay。
        overlay: false,
      },
    },
    // envPrefix 只放行 VITE_ 前缀：构建期变量留在本文件的 process.env，不进渲染层的 import.meta.env。
    envPrefix: ['VITE_'],
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') },
      },
      // Electron 的渲染层就是 Chromium：语法不需要为浏览器降级，写 esnext 比每年追 chrome 版本号稳。
      target: 'esnext',
      // 压缩器用 'oxc'：打包器已是 rolldown，Vite 8 下写 'esbuild' 会在 renderChunk 因找不到该包而崩。
      minify: NODE_ENV_VALUE !== 'production' ? false : 'oxc',
      reportCompressedSize: false,
      sourcemap: Boolean(NODE_ENV_VALUE !== 'production'),
    },
  },
})
