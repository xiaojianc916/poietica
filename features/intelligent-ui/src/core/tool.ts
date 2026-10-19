import type { AgentToolRegistry } from '@poietica/core-kernel'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { z } from 'zod'
import { INTELLIGENT_UI_HTML_MAX, INTELLIGENT_UI_URL_HOSTS } from '../contract'
import { INTELLIGENT_UI_GUIDE } from './guide'

/*
 * agent 在对话里放一个能操作的界面（intelligent_ui，原 R-18 的 show_widget）。
 *
 * 工具本身很薄：校验参数、探一下 url 来源的开发服务器活着没有，然后告诉模型「已经显示了」。
 * 渲染在 UI：toolCallRenderers 认到 intelligent_ui，用参数里的 html / url 画一个沙箱 iframe。
 * 参数随工具调用存在对话记录里，重开对话照样能看；界面自己写的状态存在本功能的表里（core/repo.ts）。
 *
 * 描述只留「什么时候用、先取指南」：它每轮都进系统提示。设计系统、桥接 API、状态的写法都在
 * intelligent_ui_guide 交回的指南里（guide.ts），模型在一次对话里第一次用之前取一次。
 */

const URL_PROBE_TIMEOUT_MS = 4000

export const INTELLIGENT_UI_TOOL = 'intelligent_ui'
export const INTELLIGENT_UI_GUIDE_TOOL = 'intelligent_ui_guide'

const intelligentUiParams = z.object({
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
    .describe('url only: fixed frame height in px (default 560). html views always follow their content.'),
  bare: z
    .boolean()
    .optional()
    .describe('html only: skip the app look (pre-styled elements and classes). Use when imitating another product.'),
})

type IntelligentUiParams = z.output<typeof intelligentUiParams>

const DESCRIPTION = [
  'Show an interactive view (a live mini app) inline in your reply: design variants side by side, interactive charts,',
  'explorable data, calculators, simulations, parameter tweakers, diagrams with controls, or a small form that collects',
  'structured choices. The view can report what the user picked; you get it with their next message.',
  `Before the first ${INTELLIGENT_UI_TOOL} call in a conversation, call ${INTELLIGENT_UI_GUIDE_TOOL} once for the`,
  'environment, design system and bridge API. Pass exactly one source: html (self-contained, scripts run, network',
  'blocked except a few library CDNs) or url (a dev server page on localhost). Do not repeat the view in your reply.',
].join('\n')

const GUIDE_DESCRIPTION = [
  `Get the full guide for ${INTELLIGENT_UI_TOOL}: sandbox rules, CSS variables and classes, the window.poietica`,
  'bridge (send, draft, open, state) and recipes. Call it once per conversation before your first view.',
].join('\n')

/** url 来源：只收本机开发服务器的 http(s) 地址，交回规范化后的 URL */
export function intelligentUiUrlOf(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new AppError(SystemErrorCode.invalidParams, `界面地址不是合法的 URL：${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(SystemErrorCode.invalidParams, `界面地址只能是 http(s)：${raw}`)
  }
  if (!INTELLIGENT_UI_URL_HOSTS.includes(url.hostname)) {
    throw new AppError(
      SystemErrorCode.invalidParams,
      `界面地址只能指向本机开发服务器（${INTELLIGENT_UI_URL_HOSTS.join(' / ')}）：${raw}`,
    )
  }
  if (url.username !== '' || url.password !== '') {
    throw new AppError(SystemErrorCode.invalidParams, `界面地址里不能带用户名或密码：${raw}`)
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
      `打不开 ${url.href}：开发服务器没有响应（${cause instanceof Error ? cause.message : String(cause)}）。先在后台启动开发服务器，再调用 intelligent_ui`,
    )
  }
  await response.body?.cancel()
  if (response.status >= 400) {
    throw new AppError(SystemErrorCode.invalidParams, `打不开 ${url.href}：开发服务器返回 HTTP ${response.status}`)
  }
  return response.status
}

export function registerIntelligentUiTools(d: {
  readonly tools: AgentToolRegistry
  /** 测试注入；缺省用全局 fetch */
  readonly fetch?: ProbeFetch
}): void {
  const fetchPage = d.fetch ?? globalFetch
  d.tools.register({
    name: INTELLIGENT_UI_GUIDE_TOOL,
    label: '智能界面指南',
    description: GUIDE_DESCRIPTION,
    parameters: z.object({}),
    approval: 'read',
    async execute() {
      return { text: INTELLIGENT_UI_GUIDE }
    },
  })
  d.tools.register({
    name: INTELLIGENT_UI_TOOL,
    label: '智能界面',
    description: DESCRIPTION,
    parameters: intelligentUiParams,
    approval: 'read',
    async execute(params: IntelligentUiParams, ctx) {
      const hasHtml = params.html !== undefined && params.html.trim() !== ''
      const hasUrl = params.url !== undefined && params.url.trim() !== ''
      if (hasHtml === hasUrl) {
        throw new AppError(SystemErrorCode.invalidParams, 'intelligent_ui 要且只要一种来源：html 或 url')
      }
      if (hasHtml) {
        const size = params.html?.length ?? 0
        if (size > INTELLIGENT_UI_HTML_MAX) {
          throw new AppError(
            SystemErrorCode.invalidParams,
            `界面 HTML 太大：${Math.ceil(size / 1024)} KB，上限 ${INTELLIGENT_UI_HTML_MAX / 1024} KB。拆成几个界面，或改用 url 来源`,
          )
        }
        return {
          text: `View "${params.title}" is now shown to the user.`,
          details: { source: 'html' },
        }
      }
      const url = intelligentUiUrlOf(params.url ?? '')
      const status = await probe(fetchPage, url, ctx.signal)
      return {
        text: `View "${params.title}" is now showing ${url.href} (HTTP ${status}).`,
        details: { source: 'url', url: url.href },
      }
    },
  })
}
