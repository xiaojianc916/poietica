# @poietica/feature-attachments

附件库：把本地文件、剪贴板图片与超长文本收进按内容寻址的存储，并以引用登记决定回收时机。

## 职责

- **入库**：`importPaths` 读文件，`importData` 收字节；上限 50 MB，扩展名定 MIME，按 `sha256` 去重。导入只建条目，不自动挂引用。
- **存储**：内容放在 `attachmentsDir/<sha256 前两位>/<sha256>`；`attachments_files` 记内容，`attachments_items` 记每次导入，`attachments_refs` 按 `ownerKey` 记持有关系。
- **回收**：Core 就绪 60 秒后首次清理，此后每 6 小时一次；删除创建超过 24 小时且无人引用的条目，再删除无条目指向的文件。入库与清理串行。
- **预览**：图片 `previewUrl` 为 `poietica-asset://attachment/<sha256>?mime=...`；Host 只对白名单内的图片、PDF、纯文本沿用声明的 MIME，其余按 `application/octet-stream` 返回，SVG 另附 CSP。
- **引用协作**：Core 调用方用 `retain` / `releaseOwner` / `copyOwner`；UI 只能经 `attachments.setOwnerRefs` 整体替换 `ui:` 前缀的草稿引用。

## 子入口

| 入口       | 内容                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `contract` | `attachments.importPaths` / `importData` / `get` / `setOwnerRefs`；`Attachment`、`MAX_ATTACHMENT_BYTES` 与错误码 |
| `core`     | 入库、去重、引用表、回收定时器与 RPC handler                                                                     |
| `core-api` | `AttachmentsServiceToken`：入库、解析、展示与引用维护                                                            |
| `host`     | 注册 `poietica-asset://attachment/` 处理器；无 Host 契约方法                                                     |
| `ui`       | 选文件、粘贴 / 拖放入库、草稿引用同步；不认识输入框                                                              |
| `ui-api`   | `AttachmentsUiToken` 与 `DraftRefSource`                                                                         |

## 对外接口

`AttachmentsServiceToken` 面向 Core：`resolve` 交出磁盘路径，`describe` 交出含 `previewUrl` 的展示信息；`importPaths` 不挂引用，调用方须 `retain`。`AttachmentsUiToken` 面向 UI：`importPaths`、`pick`、`importData`、`claimsPaste`、`fromPaste`、`fromDrop`、`trackDraftRefs`。

草稿引用同步整体替换、串行、按集合去重；草稿未从盘上恢复（`ids()` 为 `null`）时不写，Core 换代后无条件重发。

## 边界

本功能只拥有附件条目与引用，不拥有输入框、消息或草稿形态；conversation 解释这些并调用 `AttachmentsUiToken`。发送时以 `conversation:thread:<id>` 登记引用，分叉时复制；删除线程后引用消失，内容进入回收。数据归属见 [`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md) §7。
