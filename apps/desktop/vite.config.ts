import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { customErrorDiagnosticsPlugin } from './vite-plugins/custom-error-diagnostics.ts'

/*
 * Tauri 在构建时注入这两个变量。process.env 的类型是索引签名，而仓库开了
 * noPropertyAccessFromIndexSignature，点号访问是被禁止的；在这里一次性解构，
 * 好过在下面三处各写一遍方括号访问。
 */
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
   * Mermaid 面板仍然通过动态 import 按需加载，生产构建不会因此进入首屏。
   *
   * 开发环境则提前完成依赖预构建。否则它第一次出现时才进入 Vite
   * dependency optimizer；依赖或锁文件刚发生变化时，已经打开的页面可能
   * 继续请求旧 Hash 对应的 @streamdown_mermaid.js，最终得到
   * “Failed to fetch dynamically imported module”。
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
  // Do not expose the complete TAURI_* environment namespace to WebView code.
  // Build-time Tauri variables remain available here through process.env.
  envPrefix: ['VITE_'],
  build: {
    /* 浮层是第二个原生窗口，因此是第二份文档。 */
    rollupOptions: {
      input: {
        'browser-popup': 'browser-popup.html',
        index: 'index.html',
      },
    },
    // Tauri v2 renamed these: TAURI_PLATFORM/TAURI_DEBUG are v1 names, and
    // reading them silently downgraded the target and killed debug sourcemaps.
    target: TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
    /*
     * 压缩器是 oxc，因为打包器已经是 rolldown。
     *
     * Vite 8 不再依赖 esbuild：写 'esbuild' 只会把 vite:esbuild-transpile 拉进
     * renderChunk，然后在全部模块转换完之后因为找不到这个包而崩掉。为它单独装
     * 一个 esbuild 也不对——那是在 rolldown 旁边再养一条平行的转换实现，产物的
     * 语义来源就有了两个。降级仍由下面的 target 决定，oxc 照它工作。
     */
    minify: TAURI_ENV_DEBUG ? false : 'oxc',
    /*
     * 不为终端里那一列数字再压一遍产物。
     *
     * 官方对这一项的说明逐字：「Compressing large output files can be slow, so
     * disabling this may increase build performance for large projects.」它的全部
     * 产出就是那一列 gzip 数字，产物本身一个字节都不因它改变；而这个应用的资源从
     * 本地磁盘加载，那一列数字连参考意义都没有。
     */
    reportCompressedSize: false,
    sourcemap: Boolean(TAURI_ENV_DEBUG),
  },
})
