/**
 * 把渲染层的样式入口编成一份自足的 CSS，交给 review 页的真机冒烟用。
 *
 * 为什么需要它：冒烟要量的就是版面，而版面靠 Tailwind 生成的工具类，工具类又要靠 tailwindcss
 * 的 Vite 插件扫描源码才生成得出来（@tailwindcss/node 的 compile() 只认 @source/@import，
 * 没有扫描器 —— 直接调它得到的 CSS 里一个工具类都没有）。这个包只有 apps/desktop 看得见
 * （isolated linker），所以这一步住在这里，由 tooling/checks/review-page/run.ts 子进程调用。
 *
 * 用法：bun run apps/desktop/scripts/compile-styles.ts <输出 css 路径>
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import { build } from 'vite'

const out = process.argv[2]
if (out === undefined) {
  console.error('用法：bun run apps/desktop/scripts/compile-styles.ts <输出 css 路径>')
  process.exit(2)
}

const ROOT = path.resolve(import.meta.dir, '../../..')
const ENTRY = path.join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'styles.css')

/* 只编样式：插件把 css 收进 memory，用 generateBundle 取回文本。 */
const result = await build({
  root: ROOT,
  configFile: false,
  logLevel: 'error',
  plugins: [
    tailwindcss(),
    {
      name: 'capture-css',
      generateBundle(_options, bundle) {
        for (const [name, asset] of Object.entries(bundle)) {
          if (name.endsWith('.css') && asset.type === 'asset') {
            writeFileSync(out, String(asset.source))
          }
        }
      },
    },
  ],
  build: {
    write: false,
    rollupOptions: { input: ENTRY },
  },
})

if (result === undefined) {
  console.error('vite 没有交回结果')
  process.exit(2)
}
process.stdout.write(`${out}\n`)
