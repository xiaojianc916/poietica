import type { AgentToolRegistry } from '@poietica/core-kernel'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { z } from 'zod'
import { INTELLIGENT_UI_HTML_MAX, INTELLIGENT_UI_WIDE_WIDTH } from '../contract'
import { INTELLIGENT_UI_GUIDE } from './guide'

/*
 * agent 在对话里放一个能操作的界面（intelligent_ui，原 R-18 的 show_widget）。
 *
 * 工具本身很薄：校验参数，然后告诉模型「已经显示了」。渲染在 UI：toolCallRenderers 认到 intelligent_ui，
 * 用参数里的 html 画一个沙箱 iframe。参数随工具调用存在对话记录里，重开对话照样能看；界面自己写的状态
 * 存在本功能的表里（core/repo.ts）。
 *
 * `streamInput`：模型写 html 的那几十秒里，卡片就按已经写出来的部分画一个惰性预览（脚本不跑、不能点），
 * 参数写完、工具返回后在同一个 iframe 里换成真界面（外壳的预览模式，host/shell.ts）。
 *
 * 第一阶段的 url 来源（嵌本机开发服务器的页面）已删除：看真实运行中的网页交给内置浏览器（eval 里的
 * browser.open，右侧面板），它有地址栏、能截图、能被 agent 操作；嵌在对话里的那一份既不能操作、又要为它在主窗口
 * CSP 里给 localhost 开 frame-src。
 *
 * 描述只留「什么时候用、先取指南」：它每轮都进系统提示。设计系统、桥接 API、状态的写法都在
 * intelligent_ui_guide 交回的指南里（guide.ts），模型在一次对话里第一次用之前取一次。
 */

export const INTELLIGENT_UI_TOOL = 'intelligent_ui'
export const INTELLIGENT_UI_GUIDE_TOOL = 'intelligent_ui_guide'

/* 字段顺序就是 JSON Schema 里 properties 的顺序，模型大多照着写：短的开关排在 html 前面，预览一开始就知道怎么排版 */
const intelligentUiParams = z.object({
  title: z
    .string()
    .min(1)
    .max(80)
    .describe('Short title, e.g. "Input box: 3 variants". Shown while loading and used as the accessible name.'),
  wide: z
    .boolean()
    .optional()
    .describe(
      `Lay the view out at desktop width (${INTELLIGENT_UI_WIDE_WIDTH}px) and scale it down to fit the chat column. Only for full-screen app mockups.`,
    ),
  bare: z
    .boolean()
    .optional()
    .describe('Skip the app look (pre-styled elements and classes). Use when imitating another product.'),
  html: z.string().describe('Self-contained HTML (a full document or a fragment) with inline CSS and JS. Scripts run.'),
})

type IntelligentUiParams = z.output<typeof intelligentUiParams>

const DESCRIPTION = [
  'Show an interactive view (a live mini app) inline in your reply: design variants side by side, interactive charts,',
  'explorable data, calculators, simulations, parameter tweakers, diagrams with controls, or a small form that collects',
  'structured choices. The view can report what the user picked; you get it with their next message.',
  `Before the first ${INTELLIGENT_UI_TOOL} call in a conversation, call ${INTELLIGENT_UI_GUIDE_TOOL} once for the`,
  'environment, design system and bridge API. The html is self-contained: scripts run, the network is blocked except a',
  'few library CDNs. To show a real running web page (e.g. a dev server), use the built-in browser (browser.open in',
  'eval) instead. Do not repeat the view in your reply.',
].join('\n')

const GUIDE_DESCRIPTION = [
  `Get the full guide for ${INTELLIGENT_UI_TOOL}: sandbox rules, bundled libraries, CSS variables and classes, the`,
  'window.poietica bridge (send, draft, open, state, tweak) and recipes. Call it once per conversation before your first view.',
].join('\n')

export function registerIntelligentUiTools(d: { readonly tools: AgentToolRegistry }): void {
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
    streamInput: true,
    async execute(params: IntelligentUiParams) {
      if (params.html.trim() === '') {
        throw new AppError(SystemErrorCode.invalidParams, 'intelligent_ui 的 html 不能为空')
      }
      if (params.html.length > INTELLIGENT_UI_HTML_MAX) {
        throw new AppError(
          SystemErrorCode.invalidParams,
          `界面 HTML 太大：${Math.ceil(params.html.length / 1024)} KB，上限 ${INTELLIGENT_UI_HTML_MAX / 1024} KB。拆成几个界面`,
        )
      }
      return {
        text: `View "${params.title}" is now shown to the user.`,
        details: { source: 'html', ...(params.wide === true ? { wide: true } : {}) },
      }
    },
  })
}
