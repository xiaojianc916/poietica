# 0014. 附件走磁盘路径，屏幕走 transcript 卡片

> **决策 1 中"图片也以路径投递"已被 ADR 0023 取代。** 它依据的"omp 有会话媒体库、
> 走路径是登记一条可还原附件的唯一手段"在 omp 18.3.0 上不成立 —— omp 没有会话
> 媒体库，也没有以路径为入参的 prompt 面；图片必须作为 base64 `ImageContent` 交给
> `session.prompt()`。本文编号与其余决策不改（ADR 一改号就断了引用）：决策 3–6
> 与"已删的路径"继续有效，"字节永不内联"对**传输**仍然有效（见 0023 决策 4）。

- 状态：已接受，**决策 1 的图片部分由 ADR 0023 取代**
- 日期：2026-09-21
- 归属：Asset intake / conversation runtime / transcript projection

## 决策

1. ~~**图片与通用文件都以磁盘绝对路径投递，字节永不内联。**
   `PromptAttachment` 只有 `Image { path, name }` 与 `File { path, name,
   mime_type, size }` 两个变体。走路径是让 agent 登记一条能在屏幕上还原的
   会话媒体附件的**唯一**手段；顺带砍掉 base64 进出 IPC 的放大器。~~
   **图片部分作废（见 ADR 0023）：** omp 18.3.0 没有会话媒体库，投裸路径会让图片
   彻底消失。图片改走 base64 `ImageContent`。仍然成立的是：**通用文件**以磁盘路径
   投递、字节不内联，以及"字节永不内联"约束的是**传输**（IPC 与原生帧），不是
   SDK 边界。

2. **agent 塞给模型看的机器话在投影器里摘掉。**
   `packages/conversation/src/transcript/kimi-attachment.ts`（历史名，实际服务
   omp transcript）在 `inputItem` 这一个点上剥掉 "Attached file …" 与
   "Image compressed …" 之类的通知。附件由卡片画，正文只画人说的话。

3. **选择器只有一个「所有文件」过滤器。**
   `asset_formats` IPC 与 FORMATS 的 kind/extensions 列已删。进门分类在原生侧
   按文件头做一次（`crates/asset/src/formats.rs`）：`image/*` 进内存注册表走
   预览；其余全部是通用文件，嗅探不出就是 `application/octet-stream`，不再
   整批拒绝。

4. **通用文件走磁盘暂存，不进内存注册表。**
   import 时按内容摘要落到 `{temp}/composer-attachments`（`reset_temp_directory`
   启动清空；草稿只在内存里，重启两者一起没）；发送时读回暂存根、写进
   attachments_root。图片落盘后把进门时的那一份从注册表放掉，否则发过的图会
   一直占 256 MiB 预算。

5. **投影器消费 transcript 附件。**
   `turn.attachmentIds` 对照 `snapshot.attachments` 投成图片排与文件卡片。
   判据是「有没有能取回像素的 source」，不是 `media_type`：agent 给不了 source
   的图（模型不收的格式）画成卡片，而不是永远转圈的占位。纯附件消息也开一个
   用户消息锚点，`renderable` 把 `files` 算进去，否则只有附件的消息整行不画。

6. **composer 附件条按 `kind` 二分。**
   图片保留方块缩略图，通用文件渲染宽卡片（图标 + 名字 + 「类型 大小」 +
   移除）。

## 已删的路径

- `PromptAttachment::Text` 变体与 `image_url()`。
- `asset_formats` IPC 与 `crates/asset` 里的扩展名分类列（扩展名降级为 UI 卡片
  上的人读标签 `fileExtensionLabel`）。
- 投递会话那条路：`deliver_attachments`、注册表的 `adopt` / `replace_session`、
  thread 作用域的 `poietica-asset://` URL。基线时就已经没有任何生产者
  （`MessageImage` 在契约与 UI 里都在，但没人填过它），屏幕改为取自
  transcript 之后更不需要。协议面只剩 composer 预览。
- `RunFrame::PromptAdmitted` 与 `ConversationEvent::PromptAdmitted` 的
  `images` 字段。附件归属以 transcript 为准，符合宪法「本机账本不作为第二套
  对话正文」。

## 后果

- IPC 面：`AssetUploadResult.kind` 与 `AgentPromptAsset.kind` 由 `string`
  收成 `AssetKind` 枚举（`"image" | "file"`），TS 侧不再手写字符串映射。
- 投影缓存：带附件的 turn 按**解析出来的附件对象**（逐个比对）与 media 表
  身份记账，而不是按 `snapshot.attachments` 数组身份 —— 后者每次 snapshot
  都是新数组，缓存永不命中，流式期间每个 delta 都会重投全部带附件的 turn。
- 媒体代取失败最多重试 3 次（`MEDIA_ATTEMPTS`）：agent 永久没有那个 fileId
  时，无限重试会变成每次流式 delta 都发一次注定失败的请求。

## 相关代码

- 分类：`crates/asset/src/{formats.rs,intake.rs}`
- 暂存与发送：`apps/desktop/native/src/{paths.rs,asset.rs,conversation/attachment.rs}`、
  `crates/conversation-runtime/src/gateway.rs`
- 线上 part：`crates/agent-client/src/session/client.rs`
- 投影：`packages/conversation/src/transcript/{transcript-projector.ts,transcript-store.ts,kimi-attachment.ts}`
- 索引：`crates/ledger/src/index/attachments.rs`
