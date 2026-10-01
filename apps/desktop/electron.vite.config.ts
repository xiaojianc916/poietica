import { resolve } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

import { customErrorDiagnosticsPlugin } from './vite-plugins/custom-error-diagnostics.ts'

const { TAURI_ENV_DEBUG } = process.env

/* electron-vite 只读配置的 default 导出；规则例外登记在 biome.json 的 includes 白名单里。 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
    build: {
      outDir: 'dist-electron',
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
    // envPrefix 只放行 VITE_ 前缀：TAURI_* 命名空间不得暴露给 WebView，构建期变量留在本文件的 process.env。
    envPrefix: ['VITE_'],
    build: {
      outDir: 'dist',
      rollupOptions: {
        input: { index: resolve(__dirname, 'index.html') },
      },
      // Electron 的渲染层就是 Chromium：语法不需要为浏览器降级，写 esnext 比每年追 chrome 版本号稳。
      target: 'esnext',
      // 压缩器用 'oxc'：打包器已是 rolldown，Vite 8 下写 'esbuild' 会在 renderChunk 因找不到该包而崩。
      minify: TAURI_ENV_DEBUG ? false : 'oxc',
      reportCompressedSize: false,
      sourcemap: Boolean(TAURI_ENV_DEBUG),
    },
  },
})
