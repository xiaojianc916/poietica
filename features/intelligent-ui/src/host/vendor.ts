import chartJs from '../../node_modules/chart.js/dist/chart.umd.min.js?raw'
import d3 from '../../node_modules/d3/dist/d3.min.js?raw'
import lucide from '../../node_modules/lucide/dist/umd/lucide.min.js?raw'
import { INTELLIGENT_UI_LIBRARIES, type IntelligentUiLibrary } from '../contract'

/*
 * 随包库的正文：构建时由 `?raw` 原样读进 Host 的产物（Vite 的 vite:asset 与 Bun 的加载器都支持），
 * 安装包不需要另带 node_modules，也不必在 electron-builder 里加 extraResources。
 *
 * 为什么是相对路径而不是 `d3/dist/d3.min.js`：d3 与 chart.js 的 package.json 有 exports，UMD 文件不在
 * 导出表里，按包名解析会被拒绝；本包的 node_modules 下一定有它们的链接（bun 的 isolated linker，见 bunfig.toml）。
 * 版本与契约里的清单是否一致由单测钉住（host/__tests__/vendor.test.ts）。
 *
 * 末尾的 sourceMappingURL 去掉：.map 没有随包，开着开发者工具时每次都会多一条 404。
 */
const TEXTS: Readonly<Record<string, string>> = {
  'd3-7.9.0.min.js': d3,
  'chart.js-4.6.1.umd.min.js': chartJs,
  'lucide-1.61.0.min.js': lucide,
}

function withoutSourceMap(text: string): string {
  return text.replace(/\n?\/\/# sourceMappingURL=\S+\s*$/, '\n')
}

const cache = new Map<string, string>()

/** asset 文件名 → 库的正文；不在清单里的一律 null */
export function vendorText(asset: string): string | null {
  const library = INTELLIGENT_UI_LIBRARIES.find((entry) => entry.asset === asset)
  const raw = library === undefined ? undefined : TEXTS[library.asset]
  if (raw === undefined) return null
  let text = cache.get(asset)
  if (text === undefined) {
    text = withoutSourceMap(raw)
    cache.set(asset, text)
  }
  return text
}

/*
 * 从 <script> 标签里取 src，而不是在整份 html 里 includes：注释、可见文本里的示例、正文里顺口提到的地址都不算引用。
 * 只扫标签本身（跳过注释和 script 的正文），属性名与等号两边空白大小写不敏感，单双引号/无引号都认。
 * 没有用 DOM 解析器：Host 的导出是同步纯函数，构建产物里不想为这一处拖进完整 HTML 解析。
 */
const SRC_ATTR = /\ssrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i
const SCRIPT_OPEN = /^<script(?=[\s/>])/i

function tagEndOf(text: string, start: number): number {
  const rest = text.slice(start)
  let quote = ''
  for (const [i, char] of Array.from(rest).entries()) {
    if (quote !== '') {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '>') {
      return start + i
    }
  }
  return -1
}

function closeOf(text: string, from: number): number {
  const index = text.slice(from).toLowerCase().indexOf('</script')
  if (index < 0) return -1
  const at = from + index
  const end = tagEndOf(text, at)
  return end < 0 ? -1 : end
}

/** 从 from 处取一个（可能没闭合的）标签，返回结束位置与 src 值；不是 script 标签时为 null */
function scriptAt(text: string, from: number): { end: number; src: string | null } | null {
  if (!SCRIPT_OPEN.test(text.slice(from, from + 8))) return null
  const end = tagEndOf(text, from)
  if (end < 0) return null
  const attr = SRC_ATTR.exec(text.slice(from, end + 1))
  const value = (attr?.[1] ?? attr?.[2] ?? attr?.[3])?.trim()
  return { end, src: value === undefined || value === '' ? null : value }
}

/**
 * html 里出现的 <script src> 地址（按文档顺序去重；只取标签里的第一个 src，值去掉两端空白）。
 * 注释和 script 正文里的伪标签不算：那是文本，不会加载任何东西。
 */
export function scriptSourcesOf(html: string): readonly string[] {
  const sources = new Set<string>()
  let pos = 0
  while (pos < html.length) {
    const open = html.indexOf('<', pos)
    if (open < 0) break
    if (html.startsWith('<!--', open)) {
      const end = html.indexOf('-->', open + 4)
      if (end < 0) break
      pos = end + 3
      continue
    }
    const script = scriptAt(html, open)
    if (script === null) {
      pos = open + 1
      continue
    }
    if (script.src !== null) sources.add(script.src)
    const close = closeOf(html, script.end + 1)
    if (close < 0) break
    pos = close + 1
  }
  return [...sources]
}

/** 界面里精确引用到的那几个库（导出独立文件时只内嵌这些） */
export function librariesUsedBy(html: string, urlsOf: (library: IntelligentUiLibrary) => readonly string[]) {
  const sources = new Set(scriptSourcesOf(html))
  return INTELLIGENT_UI_LIBRARIES.filter((library) => urlsOf(library).some((url) => sources.has(url)))
}
