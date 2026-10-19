import type { AgentToolRegistry } from '@poietica/core-kernel'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { z } from 'zod'
import { WIDGET_HTML_MAX, WIDGET_LIBRARY_ORIGINS, WIDGET_TOKEN_NAMES, WIDGET_URL_HOSTS } from '../contract'

/*
 * agent 在对话里放一个能操作的小组件（R-18）。
 *
 * 工具本身很薄：校验参数、探一下 url 来源的开发服务器活着没有，然后告诉模型「已经显示了」。
 * 渲染在 UI：toolCallRenderers 认到 show_widget，用参数里的 html / url 画一个沙箱 iframe。
 * 参数随工具调用存在对话记录里，重开对话照样能看。
 *
 * 两种来源：html 是模型现写的页面（装进 poietica-asset://widget 的外壳里跑，脚本能跑但碰不到
 * Poietica，除几个公共 CDN 外连不出去）；url 是本机开发服务器上的页面。
 */

const URL_PROBE_TIMEOUT_MS = 4000

const showWidgetParams = z.object({
  title: z
    .string()
    .min(1)
    .max(80)
    .describe('Short title, e.g. "Input box: 3 variants". Shown while loading and used as the accessible name.'),
  html: z
    .string()
    .optional()
    .describe('Self-contained HTML (a full document or a fragment) with inline CSS and JS. Pass this or url.'),
  url: z
    .string()
    .optional()
    .describe(
      'Page on a dev server running on this machine: http://localhost:<port>/... or http://127.0.0.1:<port>/...',
    ),
  height: z
    .number()
    .int()
    .min(80)
    .max(2000)
    .optional()
    .describe('url only: fixed frame height in px (default 560). html widgets always follow their content.'),
  bare: z
    .boolean()
    .optional()
    .describe('html only: skip the app look (pre-styled elements). Use when imitating another product.'),
})

type ShowWidgetParams = z.output<typeof showWidgetParams>

const DESCRIPTION = [
  'Show an interactive widget inline in this chat: a live mini app rendered inside your reply.',
  'Use it when seeing or touching something beats reading about it: UI design variants side by side,',
  'interactive charts, explorable data, calculators, simulations, parameter tweakers, diagrams with controls,',
  'small games, or a form that collects structured choices from the user.',
  '',
  'Pass exactly one source:',
  `- html: self-contained HTML (full document or fragment, up to ${WIDGET_HTML_MAX / 1024} KB). Scripts run.`,
  `  Libraries can be loaded only from ${WIDGET_LIBRARY_ORIGINS.join(', ')} (script/link tags or ES module imports).`,
  '  All other network access (fetch, XHR, WebSocket, remote images and fonts) is blocked: inline the data, use data: URLs',
  '  for images. localStorage works but is in-memory for this view only. alert/confirm/prompt and popups do nothing.',
  '- url: a page served by a dev server on this machine (http://localhost:<port>/... or http://127.0.0.1:<port>/...).',
  '  Use it to show the real running app, e.g. a temporary preview route that renders the real components in several',
  '  variants. Start the dev server first (in the background); the tool checks that the page responds.',
  '',
  'Look and feel (html): the widget sits directly on the chat background, with no frame, and follows the light/dark theme',
  '(<html data-theme="light|dark">). Body text, headings, buttons (add class "primary" for the main one), inputs, selects,',
  'tables and code are pre-styled to match the app. Use these CSS variables instead of hard-coded colors so both themes work:',
  `${WIDGET_TOKEN_NAMES.join(', ')}.`,
  'Width is the chat column (about 720px, may be narrower): make layouts responsive. Height follows the content: do not',
  'use 100vh or full-height layouts. Set bare: true to skip the pre-styling when imitating another product.',
  '',
  "Bridge (window.poietica): poietica.send(text) sends text to you as the user's next message - call it from a click",
  'handler such as a "Use variant B" button; it only works while the user is interacting with the widget.',
  "poietica.draft(text) puts text in the user's input box without sending. poietica.open(url) opens an http(s) link in",
  'the browser. poietica.theme is "light" or "dark"; window fires a "poietica:theme" event when it changes.',
  '',
  'The widget appears as soon as this tool returns: do not repeat its content in your reply. Each call shows a new widget;',
  'it does not update an earlier one.',
].join('\n')

/** url 来源：只收本机开发服务器的 http(s) 地址，交回规范化后的 URL */
export function widgetUrlOf(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new AppError(SystemErrorCode.invalidParams, `组件地址不是合法的 URL：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(SystemErrorCode.invalidParams, `组件地址只能是 http(s)：${raw}`)
  }
  if (!WIDGET_URL_HOSTS.includes(url.hostname)) {
    throw new AppError(
      SystemErrorCode.invalidParams,
      `组件地址只能指向本机开发服务器（${WIDGET_URL_HOSTS.join(' / ')}）：${raw}`,
    )
  }
  if (url.username !== '' || url.password !== '') {
    throw new AppError(SystemErrorCode.invalidParams, `组件地址里不能带用户名或密码：${raw}`)
  }
  return url
}

/* 本包的 tsconfig 只带 ES2023 + bun 类型，全局 Response 的形状不全（同 python/core/index.ts 的做法）：只取用到的两格 */
export interface ProbeResponse {
  readonly status: number
  readonly body: { cancel(): Promise<void> } | null
}

export type ProbeFetch = (url: string, init: { readonly signal: AbortSignal }) => Promise<ProbeResponse>

const globalFetch: ProbeFetch = async (url, init) => (await fetch(url, init)) as unknown as ProbeResponse

/** 开发服务器没起来、页面 404 时，让模型当场知道，而不是给用户一个白框 */
async function probe(fetchPage: ProbeFetch, url: URL, signal: AbortSignal): Promise<number> {
  let response: ProbeResponse
  try {
    response = await fetchPage(url.href, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(URL_PROBE_TIMEOUT_MS)]),
    })
  } catch (cause) {
    throw new AppError(
      SystemErrorCode.invalidParams,
      `打不开 ${url.href}：开发服务器没有响应（${cause instanceof Error ? cause.message : String(cause)}）。先在后台启动开发服务器，再调用 show_widget`,
    )
  }
  await response.body?.cancel()
  if (response.status >= 400) {
    throw new AppError(SystemErrorCode.invalidParams, `打不开 ${url.href}：开发服务器返回 HTTP ${response.status}`)
  }
  return response.status
}

export function registerWidgetTool(d: {
  readonly tools: AgentToolRegistry
  /** 测试注入；缺省用全局 fetch */
  readonly fetch?: ProbeFetch
}): void {
  const fetchPage = d.fetch ?? globalFetch
  d.tools.register({
    name: 'show_widget',
    label: '展示组件',
    description: DESCRIPTION,
    parameters: showWidgetParams,
    approval: 'read',
    async execute(params: ShowWidgetParams, ctx) {
      const hasHtml = params.html !== undefined && params.html.trim() !== ''
      const hasUrl = params.url !== undefined && params.url.trim() !== ''
      if (hasHtml === hasUrl) {
        throw new AppError(SystemErrorCode.invalidParams, 'show_widget 要且只要一种来源：html 或 url')
      }
      if (hasHtml) {
        const size = params.html?.length ?? 0
        if (size > WIDGET_HTML_MAX) {
          throw new AppError(
            SystemErrorCode.invalidParams,
            `组件 HTML 太大：${Math.ceil(size / 1024)} KB，上限 ${WIDGET_HTML_MAX / 1024} KB。拆成几个组件，或改用 url 来源`,
          )
        }
        return {
          text: `Widget "${params.title}" is now shown to the user.`,
          details: { source: 'html' },
        }
      }
      const url = widgetUrlOf(params.url ?? '')
      const status = await probe(fetchPage, url, ctx.signal)
      return {
        text: `Widget "${params.title}" is now showing ${url.href} (HTTP ${status}).`,
        details: { source: 'url', url: url.href },
      }
    },
  })
}
