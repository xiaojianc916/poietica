# 内置浏览器

对话表面右上角那个按钮打开的右侧面板。页面由主窗口里的原生子 webview 渲染
（WebView2，Tauri multiwebview，cargo feature \`unstable\`），不是 iframe ——
X-Frame-Options/frame-ancestors 会把大多数站点挡在 iframe 外面。

## 数据从哪来、经过谁、到哪去、谁持有唯一真相

用户点击变成一组 browser_* IPC 命令，命令改 `Tabs` 这一份领域状态，宿主把新快照经 `browser-state` 事件广播回来，
面板照快照渲染。反方向永远不发生：渲染层不自己记标签账。

- 标签模型（开着谁、活动谁、最近关闭环、地址规范化）：`crates/browser` 的
  `Tabs`，唯一真相。
- 原生 webview 实例表、几何、可见性：宿主 `browser.rs` 的 `BrowserHost`。
- 面板开合与宽度：`@poietica/browser` 的 `browserPanelStore`，走偏好管线持久化。
- 页面内的导航历史：webview 内核自己的。宿主只转发 history.back()/forward()，
  不镜像一份。

## 所有权

| 归属 | 拥有什么 | 谁允许调用 |
| --- | --- | --- |
| `crates/browser` | 标签簿语义（纯逻辑，可脱离 UI 测试） | 只有宿主 |
| `browser.rs`（宿主） | webview 实例、几何、可见性、DTO、事件 | 只有 IPC 命令层 |
| `@poietica/native-bridge` | 生成绑定上的浏览器面 | 应用层 |
| `@poietica/browser` | 面板 UI 与面板状态店，只经端口说话 | 应用层 |
| `apps/desktop` | 端口接线、dock 摆进对话表面 | 组合根 |

## 安全

三道闸，各自独立成立：

1. 子 webview 挂独立 profile（数据根 `browser/profile/`），与主界面的
   EBWebView 不共享 Cookie 与站点存储。
2. capability 清单只圈 `main` 窗口的主 webview；面板里打开的 HTTP(S) 或本机
   `file:` 页面没有任何 Tauri IPC 面可拿。地址栏只接受显式、本机、绝对 `file:` URL，
   拒绝 UNC host 与裸路径。
3. 主窗口 CSP 不为面板放宽 —— 页面根本不在主 webview 里渲染。

## agent 操控

数据从哪来、经过谁、到哪去：agent 走 omp 自己的浏览器 relay 通道
（`browser.relay`，默认端点 `http://127.0.0.1:9224`）。relay 服务端由 omp 的浏览器
前奏按需拉起，它冒充 Chrome 的 CDP 发现端点，另一侧本该由浏览器扩展拨进来 ——
应用不用扩展：主进程手上有 `webContents.debugger`，与扩展用的 `chrome.debugger`
是同一套东西，于是这一侧由 `apps/desktop/electron/browser/relay.ts` 扮演。omp 看到
的是一台普通浏览器，实际动的是面板里的 WebContentsView，一个标签一个 target。

为什么不开应用级 `remote-debugging-port` 再把 cdpUrl 指过去：那个端点上主界面自己
也是一个 page target，而 omp 挑 target 的判据是「可见的、或枚举到的第一个」
（omp 的 `src/tools/browser/attach.ts` 的 `pickElectronTarget`），agent 会一头钻进主界面；而且
整个应用的调试面就此开在回环上，本机任何进程都能连。relay 那条路上没有别的
target，「挑错页面」从根上不成立，也不用把主界面端出去。

面板不必用户先打开：relay 一接上就是「agent 正要动浏览器」的信号
（`browser-driven` 事件），`connectWorkbench` 据此把右栏开出来并切到浏览器那一段；
一个标签都没有时宿主先开一个空白标签，CDP 端点上才有页面可听。唯一真相不变：
标签模型在 Electron 侧 `browser/host.ts` 里。

原先挂的那台 playwright MCP 已删：omp 侧自带浏览器能力，而它会按浏览器类服务器
把 `@playwright/mcp` 过滤掉（node_modules/.../mcp/config.ts 的 filterBrowserMCPServers），
留着只会让设置页显示一台在会话里永远不出现的条目。

### agent 操控面的安全

CDP 端点只听 127.0.0.1，但本机任意进程都能连上并控制内核（Chrome 官方对
remote-debugging-port 给过同样的警告）。端口不写死、每次启动随机抽取，内核
profile 与主窗口隔离。要断开 agent 的手，在设置→电脑控制里关掉「浏览器控制」
即可，面板本身不受影响。

## 元素拾取

数据从哪来、经过谁、到哪去、谁持有唯一真相：工具栏拾取按钮武装
BrowserHost 的 picking 并把 PICKER_SCRIPT 注入活动标签；页面里点下元素，脚
本用浏览器原生 URLSearchParams 把 url/title/selector/text/html 编进哨兵地址
（pick.poietica.invalid）的 query 并向它发起导航；宿主在 on_navigation 认出
哨兵前缀，取消这次导航（页面原地不动），用 url crate 的 query_pairs 解码、
按字符二次鉗制（url 2000、title/selector 300、text 1000、html 4000），发
拾取事件；应用层 browser-pick.ts 把事件排成文字块，写进屏幕上这一格对话的
输入框草稿。草稿的唯一真相自始至终在 PromptInput。

为什么是哨兵导航：标签 webview 是外部 origin，结构性无 IPC —— 那是刻意保留
的隔离，不为拾取放宽。跨文档导航必触发 on_navigation，返回 false 即取消，
这是唯一不开新信道的回传口；.invalid 是 RFC 2606 保留 TLD，永不解析，即使
被取消的导航仍有请求发出（WebView2 已知行为），也到不了任何真实服务器。防
伪造：只认 browser_pick_element 之后该标签的第一次哨兵导航（用后即焚），真
实导航自动解除武装；Esc 取消走 cancel=1，宿主丢弃。

## 自动展开与装载反馈

- 自动展开：面板状态店在宿主快照上看「有地址的标签在装载」的
  0→1 边沿，面板关着且未静音就打开。手动关掉记静音（本进程内不再自弹），
  手动打开清静音；静音位在内存，不落盘。
- 活动标签只由用户与命令决定：后台标签装载不换活动标签，反馈走标签条的
  转圈与面板自动展开。
- 装载反馈：工具栏下沿的不定式脉动条；标签条与下拉列表行装载中亮转圈。

## 已知限制（如实声明）

- 后退/前进按钮不知道内核历史可不可用，永远可点；对不可后退的页面，
  history.back() 静默不动。
- agent 开新标签（Target.createTarget）在 WebView2 上由宿主拥有窗口，大概率
  不可用（待验证）；agent 的路径是在现有标签里导航，页面 window.open 由宿
  主收编成新标签。
- 标题在导航瞬间先显示主机名，装载中标签条与下拉列表行亮转圈。
- 导航失败页做不了：NavigationCompleted 的 IsSuccess/WebErrorStatus 未经
  tauri 暴露，等上游暴露再补；装载进度只有 Started/Finished 两拍，进度条因
  此是不定式。
- iframe 里的元素拾取只到 iframe 边界；拾取块的 html 截到 4000 字符。
- 端口在「抽取」与「第一个 webview 创建」之间存在被其他进程抢占的窗口，被
  抢时该次启动没有 CDP 面，条目会在下次启动对账时拆除。
- 全部标签关闭后端点上没有 page target，agent 会失聪；下次会话拉起时
  ensure_live_kernel 会重新预热出一页。
- 非 Windows 平台不抽端口、不写条目：agent 操控面暂只在 Windows 上存在。
