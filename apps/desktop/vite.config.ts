import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { customErrorDiagnosticsPlugin } from './vite-plugins/custom-error-diagnostics.ts'

const { TAURI_ENV_PLATFORM, TAURI_ENV_DEBUG } = process.env

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
    rollupOptions: {
      input: {
        index: 'index.html',
      },
    },
    // Tauri v2 改名：TAURI_PLATFORM/TAURI_DEBUG 是 v1 旧名，误用会静默降级 target 并毁掉调试 sourcemap。
    target: TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    // 压缩器用 'oxc'：打包器已是 rolldown，Vite 8 下写 'esbuild' 会在 renderChunk 因找不到该包而崩。
    minify: TAURI_ENV_DEBUG ? false : 'oxc',
    reportCompressedSize: false,
    sourcemap: Boolean(TAURI_ENV_DEBUG),
  },
})
