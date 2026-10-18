/*
 * 对话内组件（show_widget，审查 R-18）三个进程共用的几样常量。
 *
 * - Core 的工具描述要把「能从哪里加载库」告诉模型；
 * - Host 用同一张表拼组件外壳的 CSP；
 * - UI 用外壳地址做 iframe 的 src。
 *
 * 表放在 contract 里只是为了三处读同一份，不是跨进程方法。
 */

/** 组件外壳挂在资源协议的哪个 host 下：poietica-asset://widget/… */
export const WIDGET_ASSET_HOST = 'widget'

/**
 * 外壳文档的文件名。外壳的响应自己带 `Cache-Control: no-cache`（widget-shell.ts），
 * 不吃资源协议给内容寻址资产的 immutable 默认值，所以改外壳内容不必再换名字。
 */
export const WIDGET_SHELL_FILE = 'shell-1.html'

export const WIDGET_SHELL_URL = `poietica-asset://${WIDGET_ASSET_HOST}/${WIDGET_SHELL_FILE}`

/**
 * 组件能从哪些地方加载脚本、样式和字体。只放公共 npm CDN：组件能用 d3、three、
 * chart.js 这类库，但 fetch、图片、WebSocket 一律连不出去（数据只能写在组件里）。
 */
export const WIDGET_LIBRARY_ORIGINS: readonly string[] = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
  'https://esm.sh',
]

/** html 来源的上限（字符数）。组件是模型现写的，再大就该拆或者改用 url 来源 */
export const WIDGET_HTML_MAX = 262_144

/** url 来源只认本机开发服务器 */
export const WIDGET_URL_HOSTS: readonly string[] = ['localhost', '127.0.0.1']

/** 组件里能用的 CSS 变量：UI 从设计令牌求值后交给外壳，模型写样式时只用这些名字 */
export const WIDGET_TOKEN_NAMES: readonly string[] = [
  '--color-text',
  '--color-text-muted',
  '--color-text-subtle',
  '--color-surface',
  '--color-surface-raised',
  '--color-surface-sunken',
  '--color-border',
  '--color-border-strong',
  '--color-hover',
  '--color-accent',
  '--color-accent-text',
  '--color-link',
  '--color-focus',
  '--color-success',
  '--color-warning',
  '--color-danger',
  '--font-sans',
  '--font-mono',
  '--text-base',
  '--radius-sm',
  '--radius',
  '--radius-lg',
  '--shadow-sm',
  '--shadow',
]
