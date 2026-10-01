import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { customErrorDiagnosticsPlugin } from './vite-plugins/custom-error-diagnostics.ts'

/*
 * 渲染层的构建配置。宿主是 Electron 44，内嵌 Chromium 152 —— target 写死它，
 * 不再按平台在 chrome105 / safari13 之间二选一：只有一个宿主，没有第二个浏览器要迁就。
 *
 * sourcemap 与压缩跟着 Electron 给的 dev/prod 信号走（electron-vite 注入），
 * 开发构建留可读的 sourcemap，发行构建交给 oxc 压。
 */
const { ELECTRON_RENDERER_URL, NODE_ENV } = process.env
const developing = Boolean(ELECTRON_RENDERER_URL) || NODE_ENV === 'development'

export default defineConfig({
  plugins: [
    // 必须最先注册，确保捕获后续插件及 import-analysis 错误。
    customErrorDiagnosticsPlugin(),
    react(),
    tailwindcss(),
  ],
  clearScreen: false,

  /*
   * 开发期预构建 @streamdown/mermaid：否则它首次出现才进 dependency optimizer，
   * 已开页面可能继续请求旧 hash 而报 “Failed to fetch dynamically imported module”。
   */
  optimizeDeps: {
    include: ['@streamdown/mermaid'],
  },

  server: {
    // 主进程按这个端口连 dev server（apps/desktop/electron/main.ts 的 ELECTRON_RENDERER_URL）。
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
    rollupOptions: {
      input: {
        index: 'index.html',
      },
    },
    target: 'chrome152',
    // 压缩器用 'oxc'：打包器已是 rolldown，Vite 8 下写 'esbuild' 会在 renderChunk 因找不到该包而崩。
    minify: developing ? false : 'oxc',
    reportCompressedSize: false,
    sourcemap: developing,
  },
})
