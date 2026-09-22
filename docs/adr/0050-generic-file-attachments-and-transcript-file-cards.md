# 0050. Attachments reach the agent as file paths and the screen as transcript cards

- Status: Accepted
- Date: 2026-09-21
- Owners: Asset intake, conversation runtime, transcript projection

## Context

附件有两个报上来的缺陷，此前的实现两处都没解决：

1. **发一个文本文件，气泡里出现一堆奇怪内容。** kap-server 对 `file` content part
   的处理（`promptMedia.ts` 的 `buildAttachedFileNotice`，2026-09 核对的
   kimi-code TS 版）是**把它变成一句给模型看的正文**
   `Attached file "<name>" (<media_type>, <n> bytes): <path> — open it with the Read tool`；
   而 `turnPromptText` 把所有 `text` part 拼起来当 `turn.prompt`。屏幕经过取自
   transcript，于是这句机器话原样进了用户气泡。
2. **图片发出去之后气泡里不显示。** 此前图片走 `PromptAttachment::Image { data:
   base64 }`，rest 层发 `image` part 且 `source.kind = "base64"`。实测：**base64
   图片不产生任何 transcript attachment**（turn 的 `attachmentIds` 为空、
   `snapshot.attachments` 里没有它），而投影器只从 `attachmentIds` 取图 ——
   气泡里自然什么都没有。输入框预览是另一条路（本地资产协议），所以它一直正常。

外部事实（2026-09 用本机 kimi-code 起临时 daemon 实测，非只读源码）：

- `image` + `source.kind = "path"` → daemon 读盘、嗅探、必要时压缩、存进会话
  media（`<sessionDir>/media/f_*`），transcript 里登记
  `{mediaType:"image/*", name, source:{kind:"session_media", fileId}}`；
  `GET /api/v1/sessions/{id}/media/{file_id}`（要 Bearer）取回原字节。
  工作区外的路径、无扩展名的 sha256 形状文件名都验过，可用。
- `file` + `path` → 正文里那句 notice，attachment 记
  `{mediaType, name, size}`，**无 source**（即文件卡片）。
- path 形状的 part 要绝对路径、要文件真实存在、对 `isSensitiveFile` 的
  basename（`.env`、`id_rsa` 等）会拒。我们的 blob 路径是
  `<root>/<2hex>/<sha256>`，不带这些名字。
- 参考 web UI（`dist-web`）正是把上面那句 notice 从显示文本里**摘掉**的。

## Decision

1. **图片与通用文件都发磁盘绝对路径，字节一律不内联。**
   `PromptAttachment` 收成 `Image { path, name }` 与
   `File { path, name, mime_type, size }` 两个变体，删掉 `Text` 变体与
   `image_url()`。图片改走 `path` 是修缺陷 2 的**唯一**手段：只有这条路会让
   daemon 登记一条能在屏幕上还原的 `session_media` 附件。顺带不再有 base64
   进出 IPC 的放大器。
2. **屏幕上的那句机器话在投影器里摘掉**：新增
   `packages/conversation/src/transcript/kimi-attachment.ts`，在 `inputItem`
   这一个点上剥掉 notice 与图片压缩说明。附件由卡片画，正文只画人说的话。
3. **选择器只有一个「所有文件」过滤器**，删掉 `asset_formats` IPC 与 FORMATS 的
   kind/extensions 列。进门分类在原生侧按文件头做一次（`asset::classify`）：
   `image/*` 进内存注册表走预览；其余全部是通用文件，嗅探不出就是
   `application/octet-stream`，不再整批拒绝。
4. **通用文件走磁盘暂存，不进内存注册表**：import 时按内容摘要落到
   `{temp}/composer-attachments`（随 `reset_temp_directory` 启动清空；草稿本身
   只在内存里，重启两者一起没）；发送时读回暂存根、写进 attachments_root。
   图片落盘后把进门时的那一份从注册表放掉，否则发过的图会一直占着
   256MiB 预算。
5. **投递会话这条路整个删掉。** `deliver_attachments`、注册表的
   `adopt` / `replace_session` 与 thread 作用域的 `poietica-asset://` URL 只为
   「气泡里的图片从本机资产协议取」而存在；那条路在基线时就已经**没有任何
   生产者**（`MessageImage` 在契约与 UI 里都在，但没人填过它），而屏幕改为取自
   transcript 之后更不需要它。协议面只剩 composer 预览。
6. **投影器消费 transcript 附件**：`turn.attachmentIds` 对照
   `snapshot.attachments` 投成图片排与文件卡片。判据是「有没有能取回像素的
   source」，不是 `media_type`：agent 给不了 source 的图（模型不收的格式）
   画成卡片，而不是永远转圈的占位。`session_media` 的字节经新增只读 IPC
   `agent_session_media`（kap-client 手写二进制 GET，带 32MiB 上限）由
   transcript-store 代取、缓存成 data URL 后重投影；未取回画占位。纯附件消息
   也开一个用户消息锚点，且 `renderable` 要把 `files` 算进去（否则只有附件的
   消息整行不画）。
7. composer 附件条按 `kind` 二分：图片保留方块缩略图，通用文件渲染宽卡片
   （图标 + 名字 + 「类型 大小」 + 移除）。

## Consequences

- IPC 面变化：删 `asset_formats`；新增 `agent_session_media`；
  `AssetUploadResult.kind` 与 `AgentPromptAsset.kind` 由 `string` 收成
  `AssetKind` 枚举（"image" | "file"），TS 侧不再手写字符串映射。生成物已重跑。
- 本机帧日志不再记图片地址：`RunFrame::PromptAdmitted` 与
  `ConversationEvent::PromptAdmitted` 去掉 `images`（它没有消费者，且
  thread 作用域 URL 已删）。附件归属以 transcript 为准，符合「本机账本不作为
  第二套对话正文」。
- `crates/asset` 的 Format 表缩为 content_type + 文件头匹配，扩展名知识从这一层
  删除；扩展名只作为 UI 卡片上的人读标签（`fileExtensionLabel`），不参与分类。
- 投影缓存：带附件的 turn 按**解析出来的附件对象**（逐个比对）与 media 表身份
  记账，而不是按 `snapshot.attachments` 数组身份 —— 后者每次 snapshot 都是新
  数组，缓存永不命中，流式期间每个 delta 都会重投全部带附件的 turn。
- 媒体代取失败最多重试 3 次（`MEDIA_ATTEMPTS`）：服务端永久没有那个 fileId 时，
  无限重试会变成每次流式 delta 都发一次注定失败的请求。
- 未做真机验证的假设：无。Windows 选择框的 `extensions: ['*']` 已从
  `rfd` 的 `dialog_ffi.rs`（`tauri-plugin-dialog 2.7.2` → `rfd 0.16.0`）核对：
  一个 `*` 拼成 `*.*`，另加 `set_default_extension("*")`，可用。

## Evidence

- 实测（本机 kimi-code TS 版，临时 daemon，`KIMI_CODE_HOME` 指向临时目录）：
  `file`+path 的响应正文与 transcript `prompt` 里出现
  `Attached file "notes.txt" (text/plain, 22 bytes): … — open it with the Read tool`；
  `image`+base64 的 turn `attachmentIds` 为空；`image`+path 得到
  `{source:{kind:"session_media", fileId}}`，`GET …/media/{fileId}` 回同样字节。
- kimi-code：`promptMedia.ts`（`resolvePromptMediaFiles`、
  `buildAttachedFileNotice`）、`turnEvents.ts`（`turnPromptText` 拼全部 text part；
  `turnPromptAttachments` 只认 `kimi-file://`）、`coreEventMap.ts`
  （`onTurnStarted`：图片 session_media source、通用文件无 source）、
  `routes/sessionMedia.ts`（media 端点，Bearer）。
- 参考 web UI `dist-web/assets/index-*.js`：显示前把
  `Attached file "` / ` — open it with the Read tool` 与
  `<system>Image compressed to fit model limits:` 摘掉。
- 本仓路径：分类 `crates/asset/src/{formats.rs,intake.rs}`；暂存与发送
  `apps/desktop/src-tauri/src/{paths.rs,asset.rs,conversation/attachment.rs}`、
  `crates/conversation-runtime/src/gateway.rs`；线上 part
  `crates/kap-client/src/session/{client.rs,rest.rs}`；投影
  `packages/conversation/src/transcript/{transcript-projector.ts,transcript-store.ts,kimi-attachment.ts}`。
