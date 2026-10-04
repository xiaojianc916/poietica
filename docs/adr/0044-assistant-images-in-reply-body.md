# 0044 — 助手在正文里发图：走资产协议，发布根与撤回一步

日期：2026-10-04

## 背景

助手要在回复正文里显示图片。渲染链是 markdown → streamdown，而 streamdown 的默认
净化链（rehype-sanitize 的 `protocols.src` 是 `['http','https']`）只放行 http(s)，
所以本地字节要么架一个 HTTP 服务，要么把 scheme 补进白名单。

架服务是外挂：它不在产品里、随会话生死、端口会撞、还带一条本地任意文件读取的路径穿越
（实测可读出仓库根之外的文件）。而仓里本来就有一条与软件同生死的应答端：
主进程的 `protocol.handle('poietica-asset', ...)`（asset-protocol.ts）。

另有两道坎：

1. **重启后取不到字节。** 应答端的字节来自原生侧的**进程内**注册表
   （crates/asset/src/intake.rs 的 commit 只给 `ImportedKind::File` 落盘），重启即空。
   投递过的图片其实**已经落进附件根**（conversation/attachment.rs 的 keep_bytes），
   只是没有一条回头去读它的路。
2. **助手没有入口。** `asset_import`/`asset_upload` 只服务用户附图，产出的是会话令牌，
   而会话令牌每次启动都换 —— 写进正文的地址活不过一次重启。

## 决定

三处改动，各解决一条：

1. **渲染层把 scheme 补进净化白名单**（packages/conversation/src/surface/timeline/prose.tsx）。
   补的是协议名 `poietica-asset`，不是放行任意地址：`file://`、`data:`、`javascript:`
   仍在默认白名单之外。Streamdown 的 `rehypePlugins` 是**替换**语义，所以整条链
   （raw + sanitize + harden）原样重建，只改 schema 那一格 —— 少一环就是把净化摘了。

2. **应答端在注册表未命中时回落磁盘**（apps/desktop/native/src/asset.rs 的 read_attachment）。
   地址里的摘要就是内容寻址的键，按它读盘；`read_blob` 自己核对字节与摘要相符。
   两个根按令牌分派：附件根归账本（删对话会回收），发布根归助手产物。

3. **新增发布面**：crates/asset/src/publish.rs 的 `publish_image`（字节落发布根、
   按摘要去重、交回 `poietica-asset://asset/published/<hash>`），经调度器那台
   已经开给 agent 的 MCP 服务暴露成 `publish_image` 工具。

固定令牌 `published` 是刻意的：开给渲染层的会话令牌每次启动都换，而写进正文的地址要跨
重启作数。发布根与附件根分开也是刻意的：附件根归账本，删一条对话就回收没人引用的字节，
把助手产物混进去迟早被一条无关的删除带走。

## 影响

- 磁盘布局多一个 `published/`（paths::published_root），与 `attachments/` 平级；
  存储页那一格只统计 attachments，不把发布根算进去。
- IPC 契约零改动：`asset_read` 签名不变，回落到磁盘是它内部的事。
- 渲染层多一个 `rehypePlugins` 实参，替换语义由 packages/conversation 的
  prose-asset-images 测试钉住（协议放行 + 危险 scheme 仍被拦 + http 照常）。

## 未做

发布根目前没有回收：它只按摘要去重、没有引用账。等到「助手发的图会不会无限堆积」真的
成为问题再加（判据是用户盘上的体积，不是猜想）。
