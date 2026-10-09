import { z } from 'zod'

/*
 * browser 的 zod 实体（07 页 §12B 的完整代码）。线上形状只有一个产地：
 * host/tabs.ts 产出、UI 消费，两边都从这里取类型。
 */

export const BrowserTab = z.object({
  id: z.number().int().positive(), // Host 内自增，从 1 开始
  url: z.string().nullable(), // 空白标签为 null（内部是 about:blank）
  title: z.string(),
  loading: z.boolean(),
  favicon: z.string().nullable(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  zoom: z.number(), // Electron zoomLevel，0 为默认
})
export const BrowserState = z.object({
  revision: z.number().int(), // 每次变化 +1；UI 丢弃 revision 更小的通知
  tabs: z.array(BrowserTab),
  activeTabId: z.number().int().nullable(),
  pickingTabId: z.number().int().nullable(),
  recentlyClosed: z.array(z.object({ url: z.string(), title: z.string() })).max(10),
  driven: z.boolean(), // relay 已连接 = agent 正在使用浏览器
})
export type BrowserTab = z.infer<typeof BrowserTab>
export type BrowserState = z.infer<typeof BrowserState>

export const PickedElement = z.object({
  tabId: z.number().int(),
  url: z.string(),
  submission: z.enum(['attach', 'send']), // 拾取面板里用户点的是“添加到输入框”还是“直接发送”
  elementType: z.string().max(64),
  comment: z.string().max(2000),
  report: z.string().max(64_000), // Markdown：选择器、外层 HTML（截断）、计算样式摘要、页面地址
})
export type PickedElement = z.infer<typeof PickedElement>

/** 外站视图的用户数据与主界面分开（07 页 §12D）：权限在这一个会话上单独收紧。 */
export const BROWSER_PARTITION = 'persist:poietica-browser'
/** 空白页写法的唯一产地；宿主记的是「没有 url」，不是这条地址。 */
export const BLANK_PAGE = 'about:blank'
/** 拾取脚本住的隔离世界：0 是页面主世界，不能用（会被页面自己的 CSP 判死）。 */
export const PICKER_WORLD = 999
/** 拾取回调地址的宿主：页面猜不到（token）也导航不过去（不存在的域名）。 */
export const PICKER_CALLBACK_HOST = 'pick.poietica.invalid'
