/**
 * 把渲染层的样式入口编成一份自足的 CSS，交给 review 页的真机冒烟：版面靠 Tailwind 的工具类，
 * 而工具类要靠 tailwindcss 的 Vite 插件扫描源码（@tailwindcss/node 的 compile() 没有扫描器，
 * 直接调它得到的 CSS 里一个工具类都没有）。这个包只有 apps/desktop 看得见（isolated linker），
 * 所以这一步住在这里，由 tooling/checks/review-page/run.ts 子进程调用。
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

/* 只编样式：`write: false` 之下产物留在 build() 的返回值里，直接从 output 里取那一份 css，不需要自己写插件去截。 */
const result = await build({
  root: ROOT,
  configFile: false,
  logLevel: 'error',
  plugins: [tailwindcss()],
  build: {
    write: false,
    rollupOptions: { input: ENTRY },
  },
})

if (result === undefined) {
  console.error('vite 没有交回结果')
  process.exit(2)
}

/* `write: false` 时返回的一定是产物（不是 watcher）；单入口也不会是数组，这里两样都收一下免得类型上留个洞。 */
const chunks = (Array.isArray(result) ? result : [result]).flatMap((item) => ('output' in item ? item.output : []))
const css = chunks.find((item) => item.type === 'asset' && item.fileName.endsWith('.css'))

if (css === undefined || css.type !== 'asset') {
  console.error('构建产物里没有 css')
  process.exit(2)
}

writeFileSync(out, String(css.source))
process.stdout.write(`${out}\n`)
