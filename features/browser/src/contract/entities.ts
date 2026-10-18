import { z } from 'zod'

/** 站点图标挂在资源协议的哪个 host 下：poietica-asset://browser-favicon/<sha256>。 */
export const FAVICON_ASSET_HOST = 'browser-favicon'
/**
 * 标签图标只认宿主代取、按内容寻址的资源地址。外站给的原始地址（https:、data:、http://内网…）一律进不了契约：
 * 应用界面是特权渲染进程，CSP 也只放行受信协议 —— 让它直连外站，既违反信任边界，又会被 CSP 静默拦掉（地球图标就是这么来的）。
 */
export const FAVICON_URL = new RegExp(`^poietica-asset://${FAVICON_ASSET_HOST}/[a-f0-9]{64}$`)

export const BrowserTab = z.object({
  id: z.number().int().positive(), // Host 内自增，从 1 开始
  url: z.string().nullable(), // 空白标签为 null（内部是 about:blank）
  title: z.string(),
  loading: z.boolean(),
  favicon: z.string().regex(FAVICON_URL).nullable(), // 宿主代取后的 poietica-asset 地址；没有或取不回来为 null
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
  driven: z.boolean(), // 至少一张标签挂着 AI 的调试器
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

export const BROWSER_PARTITION = 'persist:poietica-browser'
/** 空白页写法的唯一产地；宿主记的是「没有 url」。 */
export const BLANK_PAGE = 'about:blank'
/** 拾取脚本住的隔离世界：0 是页面主世界，不能用（会被页面自己的 CSP 判死）。 */
export const PICKER_WORLD = 999
/** 拾取回调地址的宿主：页面猜不到（token）也导航不过去（不存在的域名）。 */
export const PICKER_CALLBACK_HOST = 'pick.poietica.invalid'
