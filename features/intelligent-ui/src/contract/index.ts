import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import { intelligentUiErrors } from './errors'

export { intelligentUiErrors } from './errors'

/*
 * 对话内智能界面（intelligent_ui，原 R-18 的 show_widget）。
 *
 * 常量三个进程共用：Core 的工具指南要把「能从哪里加载库」告诉模型；Host 用同一张表拼外壳的 CSP；
 * UI 用外壳地址做 iframe 的 src。两条 RPC 只服务「界面状态」：卡片挂载时读回、用户操作后写入。
 */

/** 外壳挂在资源协议的哪个 host 下：poietica-asset://intelligent-ui/… */
export const INTELLIGENT_UI_ASSET_HOST = 'intelligent-ui'

/**
 * 外壳文档的文件名。外壳的响应自己带 `Cache-Control: no-cache`（host/shell.ts），
 * 不吃资源协议给内容寻址资产的 immutable 默认值，所以改外壳内容不必再换名字。
 */
export const INTELLIGENT_UI_SHELL_FILE = 'shell.html'

export const INTELLIGENT_UI_SHELL_URL = `poietica-asset://${INTELLIGENT_UI_ASSET_HOST}/${INTELLIGENT_UI_SHELL_FILE}`

/**
 * 界面能从哪些地方加载脚本、样式和字体。只放公共 npm CDN：能用 d3、three、chart.js 这类库，
 * 但 fetch、图片、WebSocket 一律连不出去（数据只能写在界面里）。离线随包的库见方案第二阶段。
 */
export const INTELLIGENT_UI_LIBRARY_ORIGINS: readonly string[] = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
  'https://esm.sh',
]

/** html 来源的上限（字符数）。界面是模型现写的，再大就该拆或者改用 url 来源 */
export const INTELLIGENT_UI_HTML_MAX = 262_144

/** url 来源只认本机开发服务器 */
export const INTELLIGENT_UI_URL_HOSTS: readonly string[] = ['localhost', '127.0.0.1']

/**
 * 状态的两半，各自是一段 JSON 文本：
 * - `model`：下一句话时交给模型（只交「上次交出之后变过的」）。要短：它每次都进上下文；
 * - `view`：只给界面自己恢复用（滚回来、重开对话后还原选中项、输入值），模型看不到。
 */
export const INTELLIGENT_UI_MODEL_STATE_MAX = 4096
export const INTELLIGENT_UI_VIEW_STATE_MAX = 12_288

/** 界面里能用的 CSS 变量：UI 从设计令牌求值后交给外壳，模型写样式时只用这些名字 */
export const INTELLIGENT_UI_TOKEN_NAMES: readonly string[] = [
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

/** 外壳预置的可选类（host/shell.ts 的 BASE_CSS 定义样式，core/guide.ts 教模型用） */
export const INTELLIGENT_UI_CLASS_NAMES: readonly string[] = [
  'iu-stack',
  'iu-row',
  'iu-grid',
  'iu-card',
  'iu-muted',
  'iu-stat',
  'iu-stat-label',
  'iu-stat-value',
  'iu-badge',
  'iu-tabs',
  'iu-controls',
  'iu-ghost',
  'iu-danger',
  'iu-success',
  'iu-warning',
]

function isJsonText(text: string): boolean {
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

const StateText = (max: number) => z.string().max(max).refine(isJsonText, { message: '必须是 JSON 文本' }).nullable()

export const IntelligentUiState = z.object({
  model: StateText(INTELLIGENT_UI_MODEL_STATE_MAX),
  view: StateText(INTELLIGENT_UI_VIEW_STATE_MAX),
})
export type IntelligentUiState = z.infer<typeof IntelligentUiState>

const CallRef = z.object({ threadId: z.string().min(1), callId: z.string().min(1).max(200) })

export const intelligentUiContract = defineContract({
  id: 'intelligent-ui',
  namespaces: ['intelligentUi'],
  methods: [
    defineMethod({
      name: 'intelligentUi.getState',
      owner: 'core',
      params: CallRef,
      result: z.object({ state: IntelligentUiState.nullable() }),
      description: '读回一次界面调用的状态（卡片挂载时用；没写过为 null）',
    }),
    defineMethod({
      name: 'intelligentUi.setState',
      owner: 'core',
      /* 整份覆盖：外壳那一侧持有当前值，合并在那里做，这里每次收到的都是完整状态 */
      params: CallRef.extend({ title: z.string().min(1).max(80), ...IntelligentUiState.shape }),
      result: z.object({}),
      description: '写入一次界面调用的状态；model 变了的那份等下一句话交给模型',
    }),
  ],
  /* 没有通知：状态只有那一个界面实例在写，读写都由它发起；Core 重启后卡片下次挂载再读一次 */
  notifications: [],
  errors: intelligentUiErrors,
})
