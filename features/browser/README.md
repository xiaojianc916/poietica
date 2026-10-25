# @poietica/feature-browser

内置浏览器：右坞里的原生网页标签，并把这组标签经 relay 交给 agent 操作与拾取。

## 职责

- **标签与视图**：每张标签是一个 Electron `WebContentsView`，UI 上报视口矩形与显隐。Host 维护活动标签、最近关闭环（最多 10 项）、缩放和 `revision` 递增的快照；状态通知按 16ms 合批。
- **分区与权限**：页面运行在独立的 `BROWSER_PARTITION`，只放行 `clipboard-sanitized-write` 与 `fullscreen`，拒绝设备权限；下载走系统「另存为」。显式地址只接受 `http(s)` 与本地 `file:`，空白标签内部使用 `about:blank`；裸主机名按本地或公网补 `http` / `https`。
- **图标**：Host 用浏览器分区的会话代取站点图标，按内容哈希存入内存并以 `poietica-asset://browser-favicon/<sha256>` 提供；外站原始地址不进入契约。
- **relay**：Core 只把引擎的 relay 端口转给 Host，口令由 Host 读取 `relayTokenFile`。Host 连接 `127.0.0.1:<port>`，向 agent 暴露含备用标签的标签面；`ensureAgentPage` 在无页时补一张不显示在面板里的备用标签。`driven` 表示至少一张标签挂着 AI 调试器。
- **拾取**：在隔离世界 `999` 注入脚本，回调经不可解析的 `pick.poietica.invalid` 与一次性 token 回到 Host；用户确认后以 `browser.elementPicked` 交给 UI。

## 子入口

| 入口       | 内容                                                                       |
| ---------- | -------------------------------------------------------------------------- |
| `contract` | 标签方法与通知、`BrowserState` / `PickedElement`、favicon 资源常量、错误码 |
| `core`     | 只实现 `browser.relayEndpoint`，从引擎取 relay 端口或 `null`               |
| `host`     | 标签与视图、分区策略、favicon、地址归一、拾取、relay 客户端                |
| `ui`       | 右坞面板与标签条、地址栏 / 历史 / 缩放、拾取投递、浏览器工具卡与命令       |

## 对外接口

Host 契约方法覆盖 `state`、`newTab`、`closeTab`、`selectTab`、`reopenClosed`、`navigate`、`back` / `forward` / `reload` / `stop`、`setZoom`、`setBounds`、`setVisible`、`pickElement`、`cancelPick`；Core 方法为 `browser.relayEndpoint`。通知为 `browser.stateChanged` 与 `browser.elementPicked`。面板按 `BrowserState.revision` 丢弃旧快照。

UI 命令：`browser.toggle`（Ctrl+Shift+B）、`browser.newTab`、`browser.focusAddress`（Ctrl+Shift+L）、`browser.pickElement`。拾取报告以 Markdown 附件交给 `AttachmentsUiToken.importData`，再写入当前输入框；没有输入框时先回入口页。

错误：面板侧 `browser.invalid_url`、`browser.tab_not_found`；relay 侧 `browser.relay_tab_missing`、`browser.relay_address_rejected` 经工具结果回给 agent。

## 边界

浏览器不拥有对话、草稿或附件实体，只经 conversation 与 attachments 的 UI 服务交付拾取结果；relay 是 Host 与引擎之间的私有通道，不是契约方法。备用标签只供 agent 使用，不显示在面板；标签、关闭环与 `driven` 只活在 Host 内存。进程分工见 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §4。
