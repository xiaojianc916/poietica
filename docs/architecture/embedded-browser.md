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
| `@poietica/ipc` | 生成绑定上的浏览器面 | 应用层 |
| `@poietica/browser` | 面板 UI 与面板状态店，只经端口说话 | 应用层 |
| `apps/desktop` | 端口接线、dock 摆进对话表面 | 组合根 |

## 安全

三道闸，各自独立成立：

1. 子 webview 挂独立 profile（数据根 `browser/profile/`），与主界面的
   EBWebView 不共享 Cookie 与站点存储。
2. capability 清单只圈 `main` 窗口的主 webview；面板里打开的页面没有任何
   Tauri IPC 面可拿。
3. 主窗口 CSP 不为面板放宽 —— 页面根本不在主 webview 里渲染。

## 批次边界

本批（批次 1）只交付人操控的浏览器。批次 2 接 agent 操控：

- 经受控 home 的 mcp.json 注册 chrome-devtools-mcp（stdio 服务器由 CLI 拉起；
  会话内注册面只有 http 一支，见 `packages/plugins/src/mcp-servers.ts`）。
- 给 profile 加远程调试端口，把 CDP 接到面板里的 WebView2 实例。
- 图二那类「选择网页元素加入聊天」的拾取，喂进 composer。
- 收编 on_new_window / on_page_load：window.open 进新标签、给出加载态。

## 已知限制（批次 1 如实声明）

- 后退/前进按钮不知道内核历史可不可用，永远可点；对不可后退的页面，
  history.back() 静默不动。
- 页面里 window.open 的行为未收编。
- 标题在导航瞬间先显示主机名，等 on_document_title_changed 到位后替换。
