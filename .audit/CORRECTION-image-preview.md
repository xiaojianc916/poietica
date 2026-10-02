# 更正：我把图片附件预览改坏了（已修复并复验）

时间：2026-10-02 07:38 → 08:15。用户报告「图片预览的你改坏了啊，原本就是好的啊」。
**用户是对的。** 这条记录的是我错在哪、为什么错、以及正确的形状。

---

## 我错在哪

第一轮审查里我看到渲染层 `<img>` 对 `poietica-asset://asset/<s>/<hash>` 取不到字节，
就断定「handler 的地址形状写错了」。**结论错了，错的根因是另一件事。**

我当时用**手工放进 `%APPDATA%\Poietica\attachments\<hash前两位>\<hash>` 的文件**当测试数据。
那批文件在磁盘上，所以改了地址形状之后确实 200。但真实流程根本不往那条路走：

```
crates/asset/src/intake.rs 的 commit（182-189 行）
    ImportedKind::Image => asset_protocol_url(session, &hash)?     ← 只生成地址，不落盘
    ImportedKind::File  => store_bytes(root, &item.bytes)?          ← 只有通用文件落盘
```

图片的字节进的是**内存注册表**（`AssetProtocolRegistry`），发送那一刻才由
`apps/desktop/native/src/conversation/attachment.rs` 的 `keep_bytes` 搬进附件根。
所以按磁盘读的 handler 对**每一张真实的图**都 404 —— 我修好的只是我自己造的那份假数据。

## 改坏了什么

| 我改的 | 后果 |
| --- | --- |
| `crates/asset/src/delivery.rs` 删掉 Windows 的 `.localhost` 分支 | 单看是对的（ADR 0028 换了宿主），但它不是我该动的重点 |
| `apps/desktop/electron/asset-protocol.ts` 改成按磁盘读 `attachmentRoot/<hash>` | **每一张真实图片都 404** —— 用户看到的那个「PNG 方块」占位 |
| 测试改成造磁盘文件 | 测试与实现**一起错**，所以门禁全绿也发现不了 |

用户的截图就是结果：托盘那一格退回了 `TileFallback`（一个 PNG 字形）。

## 正确的形状

字节不在磁盘上，所以协议处理器**不能有数据根**，只能有一个取字节的口子：

1. **新增原生命令 `asset_read`**（`apps/desktop/native/src/asset.rs`）——
   按 `(sessionToken, assetToken)` 从注册表取那一份，base64 交回宿主。
   注册表本来就有 `deliver()`，这条命令只是把它接到 IPC 上。
   DTO 必须同时在 `ipc/mod.rs` 的 `types()` 里登记 —— 只进 `functions()` 会让生成的
   TypeScript 引用到没导出的类型，`tsc` 当场报错（我第一次就漏了这一步）。
2. **协议处理器收 `AssetByteSource`**，不是 `dataRoot`；`main.ts` 把它接到
   `router.invoke('asset_read', …)`。原生那侧将来换取法，这里都不用改。
3. **404 与 500 分开**：资产不在了（没进过门、或被 `asset_remove` 放掉）回 404，
   宿主自己坏了回 500。主进程的 router 抛的 Error 上挂着 problem，按 `code === 'resourceMissing'` 认，
   不认文案（文案随语言变）。

## 复验（真实流程，MCP 驱动真宿主）

走的就是渲染层那条路：`asset_session_open` → `asset_import` → 把返回值 `source` 塞进 `<img>`。

| 场景 | 结果 |
| --- | --- |
| 真实 PNG 经 `asset_import` | `img: onload 32×32`，`fetch: 200 image/png 121` |
| `Range: bytes=0-7` | **206 / bytes 0-7/121** |
| 同一张图导入两次（引用数 2） | 去掉一次仍 **200**；去掉两次 → **404** |
| 释放之后 | `fetch → 404`，`<img> → onerror`（与 500 分开了） |
| 剪贴板那条路（`asset_upload` base64） | `onload 32×32` |
| 复用 `AttachmentThumbnail` 的真实 class 渲染 | `natural 32×32 / rendered 32×32`（截图见下） |

门禁：`bun run check` **exit 0**、`ipc:check` exit 0、`test:architecture` 通过、
`@poietica/desktop test` 103 pass / 0 fail（`asset-protocol.test.ts` 6 条，替换原来那 15 条
按磁盘假设写的用例）。

## 教训

**测试数据必须来自被测系统自己的入口。** 我手工往磁盘上放文件，等于把「字节从哪来」
这个被测的核心假设替换成了我自己的假设 —— 于是实现和测试一起错，门禁还全绿。
这个仓里正确的做法是走 `asset_import` / `asset_upload`，让注册表自己产生那份字节。

范围上还有一条：`delivery.rs` 的 `.localhost` 分支该不该删是**独立的**问题，
但它不该与「预览取不到字节」绑在同一个结论里。我看到一个 404 就往地址形状上归因，
没有先问「这份字节到底住在哪」。
