import { type IntelligentUiState, intelligentUiLibraryUrls } from '../contract'
import { INTELLIGENT_UI_CSP, SHELL_JS } from './shell'
import { librariesUsedBy, vendorText } from './vendor'

/*
 * 「导出 HTML」：把一个界面做成能离开 Poietica 单独打开的 .html 文件。
 *
 * 不另写一套渲染：文件里就是同一份外壳脚本（SHELL_JS），再加一段引导 —— 它在 load 之后自己给自己发
 * poietica:render（standalone: true），外壳照常 document.open 写入界面。所以导出的界面与卡片里的一致：
 * 同样的预置样式与令牌（css 是 UI 当时求值的那份）、同样的随包库替换、同样的状态恢复（tweaks 也在内）。
 *
 * - 安全边界：外壳的 CSP 改用 <meta> 带上（文件没有响应头），去掉 meta 里不认的 sandbox。document.open
 *   不换文档的策略容器，写入后的界面仍受这张表约束（实测见方案页）；
 * - 随包库：只内嵌界面精确引用到的那几个（JSON 进 <script type="application/json">，`<` 转义），引导脚本把它们
 *   做成 blob: 地址交给外壳替换；没用到的不带，文件不必平白多出近 1 MB；
 * - 桥：send / draft 在文件里没有对话可去，丢掉；open（经手势检查）用 window.open 打开；调整面板没有卡片来画，
 *   之前调过的值照样随状态还原；
 * - document.open 会换掉 <title>：界面自己没写标题时，外壳在写完之后补回导出时的标题。
 */

export interface StandaloneInput {
  readonly title: string
  readonly html: string
  readonly bare: boolean
  readonly wide: boolean
  readonly css: string
  readonly theme: 'light' | 'dark'
  readonly state: IntelligentUiState
}

/** 外壳 CSP 去掉 sandbox：<meta> 里不认这一条（Chromium 会在控制台报一条错并忽略） */
export const STANDALONE_CSP = INTELLIGENT_UI_CSP.split('; ')
  .filter((directive) => !directive.startsWith('sandbox'))
  .join('; ')

const BOOT_JS = `(function(){'use strict';
var data=JSON.parse(document.getElementById('poietica-export').textContent),libraries={};
Object.keys(data.libraries).forEach(function(a){libraries[a]=URL.createObjectURL(new Blob([data.libraries[a]],{type:'text/javascript'}))});
function start(){var channel=new MessageChannel();
channel.port1.onmessage=function(e){var d=e.data;if(!d)return;
if(d.type==='open'&&d.gesture===true&&typeof d.url==='string'){try{var u=new URL(d.url);if(u.protocol==='http:'||u.protocol==='https:'||u.protocol==='mailto:')window.open(u.href,'_blank','noopener,noreferrer')}catch(x){}return}
if(d.type==='error'&&typeof d.message==='string')console.warn('[poietica] '+d.message)};
window.postMessage({type:'poietica:render',standalone:true,title:data.title,html:data.html,css:data.css,theme:data.theme,bare:data.bare,wide:data.wide,state:data.state,libraries:libraries},'*',[channel.port2])}
if(document.readyState==='complete')start();else addEventListener('load',start,{once:true})})();`

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) =>
    char === '&' ? '&amp;' : char === '<' ? '&lt;' : char === '>' ? '&gt;' : '&quot;',
  )
}

/** 放进 <script type="application/json">：`<` 一律转义，正文里的 </script> 就拆不开这个标签 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

export function standaloneHtml(input: StandaloneInput): string {
  const libraries: Record<string, string> = {}
  for (const library of librariesUsedBy(input.html, intelligentUiLibraryUrls)) {
    const text = vendorText(library.asset)
    if (text !== null) libraries[library.asset] = text
  }
  const data = {
    title: input.title,
    html: input.html,
    css: input.css,
    theme: input.theme,
    bare: input.bare,
    wide: input.wide,
    state: input.state,
    libraries,
  }
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(STANDALONE_CSP)}">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<meta name="generator" content="Poietica">',
    `<title>${escapeHtml(input.title)}</title>`,
    '</head><body>',
    `<script type="application/json" id="poietica-export">${scriptJson(data)}</script>`,
    `<script>${SHELL_JS}</script>`,
    `<script>${BOOT_JS}</script>`,
    '</body></html>',
    '',
  ].join('\n')
}

const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i
const FORBIDDEN = '\\/:*?"<>|'

/*
 * 文件系统不认的字符（含控制字符）换成空格；文件名里的双向文本控制符（U+202A-U+202E、U+2066-U+2069）也去掉 ——
 * 它们会让资源管理器/终端把扩展名显示成反的，是钓鱼面；孤立代理项（Array.from 拆出来的单个代理项）一并换掉。
 */
function safeChar(char: string): string {
  const code = char.charCodeAt(0)
  const bidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)
  /* Array.from 按码点拆：合法的代理对是 length=2 的一个字符串，只有落单的代理项才 length=1 */
  const loneSurrogate = char.length === 1 && code >= 0xd800 && code <= 0xdfff
  return code < 0x20 || code === 0x7f || bidi || loneSurrogate || FORBIDDEN.includes(char) ? ' ' : char
}

/** 保存对话框的默认文件名：标题去掉文件系统不认的字符；Windows 的保留名前面垫一个下划线 */
export function exportFileNameOf(title: string): string {
  const cleaned = Array.from(title, safeChar)
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim()
  const base = cleaned === '' ? '界面' : RESERVED.test(cleaned) ? `_${cleaned}` : cleaned
  return `${base}.html`
}
