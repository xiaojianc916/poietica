# 0023 — 图片实时投递走 agent 的 SDK 契约，不是磁盘路径

## 状态

已接受。**取代 ADR 0014 决策 1 的前半句**（"走路径是让 agent 登记一条能在屏幕上
还原的会话媒体附件的**唯一**手段"）。0014 的其余决策（投影器吃 transcript 附件、
通用文件走磁盘暂存、composer 附件条二分、已删的那些路径）继续有效。

## 背景

0014 决策 1 断言 omp 有"会话媒体库"，且投递一个磁盘路径就能让 agent 把附件登记
进去、屏幕再从 transcript 里还原出像素。**这件事在 omp 18.3.0 上不存在。** 依据
是它自己的源码树（`packages/agent-bridge/node_modules/@oh-my-pi/pi-coding-agent`，
版本 18.3.0；包内源码，非文档传闻）。

真实的契约只有一条：

- `AgentSession.prompt(text: string, options?: PromptOptions)`
  （`src/session/agent-session.ts:6373`）。
- `PromptOptions.images?: ImageContent[]`
  （`src/session/agent-session-types.ts:345-349`）。
- `ImageContent = { type: "image"; data: string; mimeType: string }`
  （`@oh-my-pi/pi-ai` 18.3.0 的 `dist/types/types.d.ts:592`），`data` 是 base64。
- **没有任何以路径为入参的 prompt 面**：`PromptOptions` 里没有 path 类字段，
  `AgentSession` 上也没有"登记媒体"的入口。所谓"会话媒体库"在 18.3.0 的源码树里
  不存在。

omp 官方的每个入口都是**自己把文件读出来再传 base64**，没有例外：

- CLI 附件处理 `src/cli/file-processor.ts`：读盘 → `buffer.toBase64()` → 按需
  `resizeImage` → 塞进 `ImageContent[]`（:104-133），返回 `{ text, images }`。
- print 模式 `src/modes/print-mode.ts`：`session.prompt(initialMessage, { images:
  initialImages })`。
- ACP `src/modes/acp/acp-agent.ts`：从协议块取 `block.data` 直接当
  `{ type: "image", data, mimeType }`，再 `session.prompt(text, { images })`。

所以按 0014 的实现投一个裸路径，图片**整个消失**：模型上下文没有像素，agent 不会
登记任何附件，transcript 里也就没有可还原的东西 —— 屏幕上既无预览、AI 也收不到。
这不是"降级成卡片"，是彻底丢失。

**但路径本身没有白给。** omp 有一套把自己的路径告诉模型的机制：附件可以用
`tagImageAttachmentSource(image, path, kind)` 打标
（`@oh-my-pi/pi-tui` 的 `src/prompt/image-source.ts:30`，经 export key
`@oh-my-pi/pi-tui/prompt/image-source` 导入），打标信息走 Symbol，不参与序列化、
不进模型可见的图片数据。`AgentSession` 在提交提示时读这个标记，对每个有盘上文件的
附件生成一条**隐藏的用户侧伴随通知**
（`src/session/agent-session.ts:6291` 的 `#createAttachmentSourceNotices`，
`display: false`，`customType: "image-attachment"`，正文来自
`prompts/system/image-attachment.md`，只填 `index` 与 `path`）。于是模型既拿到像素
（`images`），也拿到路径（伴随通知），`read` / 上传 / 视频抽帧这些要按路径干活的
流程照常成立。没有盘上文件的附件会被跳过 —— omp 不编造路径。

## 决策

1. **图片以 base64 `ImageContent` 投给 SDK，由桥从磁盘字节构建。** 路径继续是
   IPC 与原生侧的形状（0014 的"字节永不内联"对**传输**仍然成立，见第 4 条），
   桥在调 `prompt()` 之前把 blob 读成 base64。`AgentSession.prompt(text, { images })`
   是唯一入口。

2. **打上 `tagImageAttachmentSource`，让 agent 同时拿到路径。** 桥对每个盘上有
   来源的图片调它（`kind: "image"`），omp 自己生成那条隐藏的 `image-attachment`
   伴随通知。这样"模型看得见像素"与"agent 能按路径操作文件"两件事同时成立，我们
   不自己往正文里塞路径文本 —— 那是 omp 的机制，我们只喂它的入参。

3. **通用（非图片）文件仍是路径引用，字节永不内联。** 它们是给 agent 的 `Read`
   工具按需打开的，不是给模型看的像素。这条与 0014 一致，不变。

4. **"字节永不内联"约束的是传输，不是 SDK 边界。** 这条规则原来的目的是砍掉
   base64 在 IPC 与原生帧里的放大器（0014 决策 1 的后半句），那个目的仍然成立、
   仍然执行。但它从来不是"不把像素交给 SDK"的理由 —— `ImageContent` 的载荷**就是**
   base64，SDK 没有第二个入口。把边界规则误读成对 SDK 也生效，正是这次 bug 的成因：
   规则被执行到了它不覆盖的地方。边界画在桥里：IPC 之上不传字节，桥之下按 SDK
   要求传字节。

5. **实时发送的图片走回放已经在用的那条 op。** 桥在发送时投一条
   `attachment.upsert`（`packages/agent-bridge/src/projection.ts:471` 的
   `attachmentOp`，`source: { kind: "url", url: <data URL> }`），与读会话文件回放
   历史图片走的是**同一条** op、同一个投影器入口。因此实时那一轮与重开之后水合的
   那一轮渲染完全一致，屏幕不需要第二条画图的通道，也不需要为实时另立状态。
   0014 决策 5 的投影器判据（"有没有能取回像素的 source"）原样适用。

## 后果

- 图片有了真实的模型上下文；发送即可在屏幕上看到，重开也还能看到。
- 桥多一次读盘与 base64 编码，并需要一个体积上限：base64 有约四分之三的膨胀，
  超限必须是报错而不是 OOM。上限与内容判定照抄 omp 上游 CLI
  （`src/cli/file-processor.ts:25` 的 `MAX_CLI_IMAGE_BYTES` 与 pi-utils 的
  `readImageMetadata`），不另立一套。模型侧的图片预算仍由 omp 自己的
  `provider-image-budget.ts` 管。
- 通用文件与图片的投递形状正式分叉：前者是路径引用，后者是像素 + 路径。这个分叉
  是 omp 契约的形状，不是我们的设计选择。分派判据只有一个（`kind`），两张表不同时
  存在。
- 原生侧的 `PromptAttachment` 不再按变体分叉字节的走法：它只交事实（路径、类别、
  显示名），`kind` 是桥那一侧唯一的分派判据（`image` 交像素、`file` 只当引用）。
  此前把它写成"图片与通用文件两条路都是磁盘绝对路径"是错的，且正是 bug 的成因。
- 不再有人可以援引"会话媒体库"来解释附件行为 —— 18.3.0 没有这个库。

## 相关代码

- SDK 契约：`packages/agent-bridge/node_modules/@oh-my-pi/pi-coding-agent/src/session/{agent-session.ts,agent-session-types.ts}`
- 路径伴随通知：上文 `agent-session.ts` 的 `#createAttachmentSourceNotices`、
  `prompts/system/image-attachment.md`；标记来自
  `@oh-my-pi/pi-tui` 的 `src/prompt/image-source.ts`（该包不在
  `pi-coding-agent` 的源码树里，在 `node_modules/.bun/@oh-my-pi+pi-tui@18.3.0/`
  下，与 `pi-coding-agent` 同为 18.3.0）
- 官方入口参照：`.../src/cli/file-processor.ts`、`.../src/modes/print-mode.ts`、
  `.../src/modes/acp/acp-agent.ts`
- 桥：`packages/agent-bridge/src/{projection.ts,bridge.ts}`
- 线上与原生侧：`crates/agent-client/src/session/client.rs`（`PromptAttachment`）、
  `crates/agent-client/src/session/bridge.rs`
- 暂存与发送：`apps/desktop/src-tauri/src/{asset.rs,conversation/attachment.rs}`

（omp 行为锚定 **18.3.0**，上述路径以本仓 vendored 源码树为准，日期 2026-09-29。）
