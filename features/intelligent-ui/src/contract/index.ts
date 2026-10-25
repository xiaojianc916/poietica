import { defineContract, defineMethod } from '@poietica/contract-kit'
import { z } from 'zod'
import { intelligentUiErrors } from './errors'

export { intelligentUiErrors } from './errors'
export { exportFileNameOf } from './file-name'

/*
 * 对话内智能界面（intelligent_ui，原 R-18 的 show_widget）。
 *
 * 常量三个进程共用：Core 的工具指南要把「能从哪里加载库、随包带了哪些库」告诉模型；Host 用同一张表拼外壳的
 * CSP、挂随包库；UI 用外壳地址做 iframe 的 src。RPC 分两组：Core 管「界面状态」（卡片挂载时读回、用户操作后写入）；
 * Host 管要碰窗口与文件系统的两件事（复制为图片、导出 HTML）。
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
 * 但 fetch、图片、WebSocket 一律连不出去（数据只能写在界面里）。常用的几个库另有随包的一份（下面的清单），离线也能用。
 */
export const INTELLIGENT_UI_LIBRARY_ORIGINS: readonly string[] = [
  'https://cdn.jsdelivr.net',
  'https://unpkg.com',
  'https://cdnjs.cloudflare.com',
  'https://esm.sh',
]

/** 随包库挂在外壳同一个 host 下的哪一段：poietica-asset://intelligent-ui/vendor/<asset> */
export const INTELLIGENT_UI_VENDOR_SEGMENT = 'vendor'

export interface IntelligentUiLibrary {
  /** npm 包名，也是 CDN 地址里的那一段 */
  readonly name: string
  readonly version: string
  /** 包里的 UMD 文件（classic <script> 能直接用、挂一个全局） */
  readonly file: string
  /** 挂到 window 上的全局名 */
  readonly global: string
  readonly license: string
  /** 本地文件名（vendor/ 下） */
  readonly asset: string
}

/**
 * 随包的库（版本钉死，与 features/intelligent-ui/package.json 的依赖一致，有单测钉住）。
 *
 * 模型照常写 CDN 地址；外壳在写入界面之前把**精确匹配**的那几个地址（下面 `intelligentUiLibraryUrls` 给出的
 * jsDelivr / unpkg 两种写法）换成本地的一份 —— 离线能用、不等网络、也不把「用户在看什么」漏给 CDN。
 * 别的版本、别的文件照旧走 CDN，不猜。只收 UMD：classic <script> 不受跨源模块加载的 CORS 约束。
 */
export const INTELLIGENT_UI_LIBRARIES: readonly IntelligentUiLibrary[] = [
  { name: 'd3', version: '7.9.0', file: 'dist/d3.min.js', global: 'd3', license: 'ISC', asset: 'd3-7.9.0.min.js' },
  {
    name: 'chart.js',
    version: '4.6.1',
    file: 'dist/chart.umd.min.js',
    global: 'Chart',
    license: 'MIT',
    asset: 'chart.js-4.6.1.umd.min.js',
  },
  {
    name: 'lucide',
    version: '1.61.0',
    file: 'dist/umd/lucide.min.js',
    global: 'lucide',
    license: 'ISC',
    asset: 'lucide-1.61.0.min.js',
  },
]

/** 外壳认的 CDN 写法（精确匹配）。第一条是指南里推荐给模型的那一条 */
export function intelligentUiLibraryUrls(library: IntelligentUiLibrary): readonly string[] {
  const path = `${library.name}@${library.version}/${library.file}`
  return [`https://cdn.jsdelivr.net/npm/${path}`, `https://unpkg.com/${path}`]
}

export function intelligentUiVendorUrl(library: IntelligentUiLibrary): string {
  return `poietica-asset://${INTELLIGENT_UI_ASSET_HOST}/${INTELLIGENT_UI_VENDOR_SEGMENT}/${library.asset}`
}

/** html 的上限（字符数）。界面是模型现写的，再大就该拆成几个界面 */
export const INTELLIGENT_UI_HTML_MAX = 262_144

/** `wide` 界面按多宽排版：整屏桌面应用的样机按这个宽度画，再整体缩放到对话栏的宽度（展开时原尺寸） */
export const INTELLIGENT_UI_WIDE_WIDTH = 1100

/**
 * 状态的三份，各自是一段 JSON 文本：
 * - `model`：下一句话时交给模型（只交「上次交出之后变过的」）。要短：它每次都进上下文；
 * - `view`：只给界面自己恢复用（滚回来、重开对话后还原选中项、输入值），模型看不到；
 * - `tweaks`：用户在卡片的「调整」面板里改过的值（按面板分组，只记与默认值不同的那些）。随 model 一起交给模型，
 *   界面重建时外壳按组还原。
 */
export const INTELLIGENT_UI_MODEL_STATE_MAX = 4096
export const INTELLIGENT_UI_VIEW_STATE_MAX = 12_288
export const INTELLIGENT_UI_TWEAKS_STATE_MAX = 4096

/**
 * 「调整」面板（poietica.tweak）：界面登记几组参数控件，卡片在界面外面画成原生控件 —— 用户调参不用模型
 * 先把滑块写进界面，界面也不必自己画一套。上限防界面写坏了刷屏。
 */
export const INTELLIGENT_UI_TWEAK_GROUPS_MAX = 8
export const INTELLIGENT_UI_TWEAK_CONTROLS_MAX = 12
export const INTELLIGENT_UI_TWEAK_OPTIONS_MAX = 12
export const INTELLIGENT_UI_TWEAK_TYPES: readonly string[] = ['range', 'color', 'toggle', 'select']

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
  tweaks: StateText(INTELLIGENT_UI_TWEAKS_STATE_MAX),
})
export type IntelligentUiState = z.infer<typeof IntelligentUiState>

const CallRef = z.object({ threadId: z.string().min(1), callId: z.string().min(1).max(200) })

/** 主窗口里的一块矩形（CSS 像素，相对窗口内容区左上角；可以有一部分在窗口外，Host 裁掉） */
const Rect = z.object({
  x: z.number().min(-20_000).max(20_000),
  y: z.number().min(-20_000).max(20_000),
  width: z.number().positive().max(20_000),
  height: z.number().positive().max(20_000),
})

export const intelligentUiContract = defineContract({
  id: 'intelligent-ui',
  namespaces: ['intelligentUi'],
  methods: [
    defineMethod({
      name: 'intelligentUi.getState',
      owner: 'core',
      params: CallRef,
      result: z.object({ state: IntelligentUiState.nullable() }),
      /*
       * 刻意不校验线程：卡片卸载/线程删除之后仍要能读（读不到就是 null），而行会随 threadRemoved 清掉。
       * 写（setState）才校验线程 —— 往已删线程里写只会留一行永远没人清的孤账。别把这里改成抛 thread_not_found。
       */
      description:
        '读回一次界面调用的状态（卡片挂载时用；没写过或线程已删除均为 null，后者是刻意语义：卡片卸载后仍可读，行会随 threadRemoved 清掉）',
    }),
    defineMethod({
      name: 'intelligentUi.setState',
      owner: 'core',
      /* 整份覆盖：外壳那一侧持有当前值，合并在那里做，这里每次收到的都是完整状态 */
      params: CallRef.extend({ title: z.string().min(1).max(80), ...IntelligentUiState.shape }),
      result: z.object({}),
      description: '写入一次界面调用的状态；model 或 tweaks 变了的那份等下一句话交给模型',
    }),
    defineMethod({
      name: 'intelligentUi.copyImage',
      owner: 'host',
      params: z.object({ rect: Rect }),
      result: z.object({}),
      description: '把主窗口里这块矩形（界面所在的位置）截下来放进剪贴板',
    }),
    defineMethod({
      name: 'intelligentUi.exportHtml',
      owner: 'host',
      params: z.object({
        /* 保存路径先经 platform 的 dialog.pickSavePath 选定；取消由 UI 短路，不调用这里 */
        path: z.string().min(1),
        title: z.string().min(1).max(80),
        html: z.string().max(INTELLIGENT_UI_HTML_MAX),
        bare: z.boolean(),
        wide: z.boolean(),
        /* 求值后的设计令牌（:root{…}）与当时的主题：导出的文件离开应用也长一个样 */
        css: z.string().max(16_384),
        theme: z.enum(['light', 'dark']),
        state: IntelligentUiState,
      }),
      result: z.object({ path: z.string().nullable() }),
      /* 要等用户在保存对话框里选位置 */
      timeoutMs: 0,
      description: '把界面导出成一个独立的 HTML 文件（随包库内嵌、状态带上）；用户取消保存为 null',
    }),
  ],
  /* 没有通知：状态只有那一个界面实例在写，读写都由它发起；Core 重启后卡片下次挂载再读一次 */
  notifications: [],
  errors: intelligentUiErrors,
})
